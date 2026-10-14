# Gotchas

- **The human channel is off by default.** `--human` (or `PI_AS_MCP_HUMAN=1`) turns on the
  `human_*` tools, the `<human>` prompt section, and the approval gate as one
  unit — nothing may be half-on, because a model told about a tool it cannot call will call
  it. Verified over real stdio traffic: without the flag `tools/list` returns no `human_*`
  entries, the prompt contains no `<human>` section, and `human_say` returns an error
  naming the missing flag. Consequence for the probes: every script that exercises the
  channel passes `--human` explicitly. **The web UI is not part of this unit**, and
  conflating the two was a real bug: it made `--oauth` impossible to use without a
  conversation channel (see the next entry).
- **`--oauth` starts the web UI, and that is not `--human`.** An earlier version made
  `--oauth` without `--human` a hard exit, on the reasoning that the approval page belongs to
  the human channel. It does not: the page is where Allow/Deny lives, and a client configured
  by hand needs a click, not a conversation. `Config.humanUI` is the single derived answer
  (`human || oauth`) and both the UI start and the tool-call timeline read it. The gate's
  answer still arrives through the channel, so `--approve` still needs `--human`: the
  composer is gone when only `--oauth` is on, and a gate nobody can answer is not a gate.
- **A hosted client is added with credentials from here, not by registering itself.** Gemini's
  "custom connected app" asks the human for a client id, a client secret and (behind a button)
  a redirect URI to allow. So the bridge mints a confidential client and prints its
  credentials, and that client was never sent to `/register`. Three consequences worth
  keeping: the credentials are per-run unless `--oauth-client-id`/`--oauth-client-secret` pin
  them; the client's name on the consent card is the redirect URI's host, because that is the
  part the human recognises; and `--oauth-redirect` only decides whether the address is known
  *in advance* (see the next entry).
- **The redirect URI is learned late by default, because that is the only order that works.**
  The credentials have to be pasted into the hosted product *before* it shows the human its
  callback address, so at startup there is no address to register and `--oauth-redirect` can
  never be mandatory. The first shape shipped this wrong: credentials were minted only when
  `--oauth-redirect` was given, so plain `pimcp` printed no client id at all and a
  hand-configured client could not be added without being told a URI the product had not
  revealed yet. Now the pair is always minted and printed, an unregistered address from a
  client that has a secret is accepted, and it is printed in full on the card where Allow/Deny
  live, under a line saying the address was not set up in advance. `decide()` records it on
  approval (`OAuthProvider.learnRedirect`, capped at 5 per client), so a repeat of the same
  address is not flagged again while a *different* one is. The probe pins the whole sequence
  on a server started the way the launcher starts one: credentials pinned, no
  `--oauth-redirect`, then first-time address → card → approval → tokens, then the same
  address unflagged, then a new one flagged, then a public client refused outright.
- **A scope this bridge does not have is narrowed, not refused.** This reverses an earlier
  choice that returned `invalid_scope`. A hosted client asks for whatever its own platform
  taught it to ask for (`openid`, `email`) and has no way to learn that this bridge offers
  only `mcp`, so refusing locks it out for a reason that is not its fault. RFC 6749 §3.3
  allows issuing less than was requested. The invariant that survives is the other
  direction: never grant more. `scripts/oauth-probe.mjs` asserts the scope on the *token*,
  not just on the consent page.
- **The SDK's `/token` cannot serve a client that skips PKCE, so `src/oauth-http.ts` does.**
  `AuthorizationCodeGrantSchema` has `code_verifier: z.string()` — required, not optional —
  so `provider.skipLocalPkceValidation` does not help and neither does returning an empty
  challenge: a client that sends nothing is rejected by zod before the provider is consulted.
  Likewise `clientAuth.js` reads the secret only from the POST body, never from Basic. Both
  are correct for a client that implements the MCP specification itself, and both are wrong
  for one the human configured by hand. Our handlers mount first on those two paths and the
  SDK's are shadowed; `/register`, `/revoke` and the metadata documents are still the SDK's.
- **`express-rate-limit` is a direct dependency now.** It was only ever reached through the
  SDK, and the SDK's rate limiting stopped covering `/token` the moment our handler replaced
  it. Relying on a transitive dependency for the thing standing between the internet and a
  shell token is not a trade worth making.
- **`--approve` without `--human` is a hard exit, not a warning.** The approval gate's whole
  value is failing closed, and with no human there is no answerer — so a gate would have to
  either deny everything or allow everything. Both are wrong, so `src/index.ts` exits with
  a message instead of picking one.
- **The advertised OAuth issuer carries a trailing slash, and that is not a bug to fix.**
  `mcpAuthRouter` writes both the issuer and the resource metadata from `URL.href`, so a bare
  origin comes out as `https://host/`. What matters is that `authorization_servers[0]` in the
  protected-resource metadata and `issuer` in the authorization-server metadata are the *same
  string* — a client resolves the metadata URL from the first and compares the second against
  it — and `scripts/oauth-probe.mjs` asserts exactly that. Changing one without the other would
  break every client, locally invisibly. The launcher's banner has the same duty and mirrors
  the normalization, because printing the raw option once produced `issuer: null`.
- **The SDK's authorization endpoints are rate-limited, and a tunnel always sets
  `X-Forwarded-For`.** Express will not key a limiter on a header it has not been told to
  trust, which surfaces as per-request noise or a 500 that only happens behind the tunnel.
  `src/index.ts` sets `trust proxy 1` for that single hop, and the OAuth probe sends the header
  on every authorization request so this cannot regress unnoticed.
- **express and its types.** The HTTP transport is a real express app now, because
  `mcpAuthRouter` needs one. `express` is a dependency (it is also the SDK's), and
  `@types/express` is a devDependency — without it `tsc` fails on our own `import express`,
  even though `skipLibCheck` hides the same missing types inside the SDK's `.d.ts` files.
- **`--approve` without `--human` is a hard exit, not a warning.** The approval gate's whole
  value is failing closed, and with no human there is no answerer — so a gate would have to
  either deny everything or allow everything. Both are wrong, so `src/index.ts` exits with
  a message instead of picking one.
- **The default tool list is platform-aware.** Pi's `getPowerShellConfig()` throws
  `The powershell tool is only available on Windows` on any other platform, but the
  resolver is lazy, so the tool *defines* fine and only fails when called. Advertising a
  tool that can never succeed is noise, so `src/config.ts` drops `powershell` from the
  default list off Windows; `--tools` still wins in both directions.
- **Do not mark `*.json` external when bundling with esbuild.** ajv (via the MCP SDK) does
  a dynamic `require("./refs/data.json")`. In ESM that is not supported, and esbuild's CJS
  interop shim only satisfies it when the JSON is in the bundle. `scripts/package.mjs` marks
  only `@silvia-odwyer/photon-node` and the Node builtins external, deliberately.
- **Pi's tool modules cannot be imported statically, so bundling them needs a seam.**
  Pi's `exports` map has no subpath for `dist/core/tools/*`, so a deep specifier fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — and Node ignores tsconfig `paths`, so the alias only
  helps tsc and esbuild. That is why `src/pi-tools.ts` resolves the entry at runtime.
  esbuild cannot inline a runtime-resolved specifier, so `scripts/package.mjs` rewrites the
  `await import(piToolEntryUrl())` call into a literal import of `src/pi-tools-entry.ts`,
  whose tsconfig alias points at the installed package. Two dead ends worth not repeating:
  `define` does **not** work (esbuild emits `if (true) return "…"` and still leaves the
  dynamic import), and a `format: "cjs"` bundle is impossible because `src/index.ts`
  awaits the listener at top level.
- **Node ignores tsconfig `paths`, so a path alias is not a runtime import.** This is what
  makes Pi's tools unimportable statically: `paths` satisfies tsc and esbuild, but Node's
  resolver only honours `exports`, and Pi's map has no subpath for `dist/core/tools/*`. The
  symptom is `ERR_PACKAGE_PATH_NOT_EXPORTED` at startup with a clean `tsc --noEmit` — which
  is exactly why it looks like a typecheck bug and is not. Proven by running
  `node src/index.ts` after the switch.
- **The ESM bundle has no `require`, and Pi's bash tool needs one.** `cross-spawn` is CJS, so
  esbuild wraps it and its `require("child_process")` hits the interop shim, which throws
  `Dynamic require of "child_process" is not supported`. A `createRequire` banner in
  `scripts/package.mjs` restores it. Externals must list **both** spellings of every
  builtin: a CJS dependency writes the bare form, and esbuild does not normalise it to
  `node:` before matching, so `"node:*"` alone silently misses it.
- **The two Node archives have different layouts.** The Windows zip puts `node.exe` at the
  archive root beside npm/npx/corepack; the Linux tarball puts `node` under `bin/` with the
  same companions. `downloadNode` normalizes both to `runtime/<node>` and deletes the
  toolchain, so the launchers can name one path. This cost three builds to get right.
- **Deleting `runtime/bin/` does not delete npm.** It removes the launchers; the packages
  themselves sit in `lib/node_modules` (17MB on Linux, ~53MB on Windows) and `share/` holds
  man pages. The bridge spawns `node` on its own bundle and never runs a package manager, so
  `downloadNode` drops all three and then removes `lib/` once it is empty. Leaving them in
  was the single largest avoidable cost in the package, and nothing in `src/` or the
  packaged launcher references npm — worth re-checking if that ever changes.
- **Only Pi's lazy wasm belongs in the package's `node_modules`, and it belongs under the bare
  name.** esbuild inlines every static import — Pi's tool graph, the MCP SDK, and express when
  `--oauth` is built in — so a packaged build with `@modelcontextprotocol` deleted outright
  served initialize, `read`, `bash`, `human_say` and a complete OAuth flow; its 5.6MB copy was
  dead weight (`KEEP` in `scripts/package.mjs` no longer copies it). The one real exception is
  `@silvia-odwyer/photon-node`, which Pi reaches with a dynamic `import()` that fires only when
  an image needs shrinking; npm installed it *nested* under Pi, and the bundle asks for it by
  bare name from `app/index.mjs`, so Node starts that lookup at `app/node_modules/@silvia-odwyer`
  and never sees the nested copy. The symptom was `ERR_MODULE_NOT_FOUND` from
  `node -e "import('@silvia-odwyer/photon-node')"` inside a built `app/` that otherwise worked
  perfectly; `KEEP` is now `[source, destination]` pairs whose destination is the bare name.
  Measured together: 155.1MB → 150.7MB, `app/` 12M → 5.9M.
- **Git Bash's `tar` is MSYS GNU tar: it reads `D:\…` as `host:path`, and it cannot read a
  zip at all.** Both halves bit `npm run package` on Windows, in sequence, and the second only
  became visible after the first was worked around. `tar -xf D:\dist\node-v….zip` → `tar:
  Cannot execute remote shell: No such file or directory`; with forward slashes instead →
  `tar: Cannot connect to D: resolve failed` (still rsh: the colon is the host separator, and
  `MSYS_NO_PATHCONV=1` changes nothing because it is tar's own argument parsing, not path
  conversion); with the path made relative to `dist/` → `tar: This does not look like a tar
  archive`, because GNU tar is not bsdtar and never reads a zip. The same command works from
  PowerShell only because `tar` there *is* bsdtar. `scripts/package.mjs` now names the
  extractor itself — `TAR` is `%SystemRoot%\System32\tar.exe` on Windows, plain `tar`
  elsewhere — and passes paths relative to `dist/` with `cwd: dist`, so the build no longer
  depends on which shell started it. `curl`, in the same function, was never affected (it is a
  native Windows binary). Before that fix, the byte-identical 36.4MB zip extracted fine under
  PowerShell and failed under Git Bash, which is exactly the kind of difference that reads as
  "the download is corrupt" and is not.
- **The packaged launcher lives at the package root, so it must not `..` its way up.**
  `dist/<platform>/pimcp.mjs` finds `app/`, `runtime/` and `bin/` as siblings; a `..` makes
  it look in `dist/app/index.mjs`, which does not exist, and every run dies with "this
  package is incomplete". Verified by running the built artifact from a bare PATH.
- **The packaged launcher and the checkout launcher are different programs.**
  `bin/pimcp.mjs` is for the repository: it spawns `src/index.ts` through
  `bin/supervise.mjs` and needs cloudflared on PATH. `bin/pimcp-packaged.mjs` is what ships
  in `dist/`: it runs the bundled `app/index.mjs` with the bundled runtime, supervises the
  child itself (there is no supervise.mjs in a package), and finds cloudflared vendored at
  `bin/`. Keep them in sync deliberately — the flags, the readiness signal and the
  `Registered tunnel connection` check are duplicated on purpose, because a package that
  drifts from the checkout is worse than two files. The duplication has grown, and it is
  worth naming: **argument parsing, which flags default to on (`--oauth`), the minting of a
  hand-configured client's credentials (now unconditional), and the wording of the ready
  banner** now exist twice. A change to any of those four belongs in both files in the same
  commit; if a fifth appears, extract them into a module both can import instead of adding to
  the pile.
- **Vendor the portable cloudflared, not the nearest one.** The official release is
  statically linked, so it runs anywhere; a Homebrew copy points its ELF interpreter at
  `/home/linuxbrew/.linuxbrew/lib/ld.so`, which the recipient does not have, and shipping it
  verbatim makes the binary itself unstartable. `vendorCloudflared` therefore tries the
  GitHub release first and only falls back to a local install, rewriting the interpreter
  itself when it is non-standard (no patchelf dependency). Reading the bytes out of WSL
  goes through `wsl cat`, never `wsl cp` with a Windows path — WSL treats that as a literal
  filename and mangles the drive colon and spaces into fullwidth characters.
- **A packaged bridge can be reached from the internet, so `--token` is not optional in
  spirit.** The packaged launcher mints one by default and prints it; `--no-tunnel` keeps
  everything on localhost. The bridge also logs a warning and the UI shows a red banner
  when the HTTP port has no token.

- **Cloudflare drops a silent origin after ~100s.** That is why the human block cap defaults to
  90s. Raising `--block-ms` past that risks a 524 before the human answers.
- **Quick tunnels rotate hostnames on every restart.** A stale URL gives Cloudflare error
  1033 / HTTP 530 — it does not mean the server is down.
- **`human_ask`/`human_wait` may return `no_message`.** That is a "the human has not spoken
  yet" signal, not a failure. Do not assume the prompt is enough: a real client agent called
  `human_wait` once, got `no_message`, and ended its turn — silently dropping the human. So
  `humanResult()` in `src/server.ts` now leads every `no_message` with a plain sentence telling
  the model to call again, and the `<human>` section names the failure mode outright. This
  deliberately reverses the earlier "state the rules once, never per result" decision: evidence
  beat the tidier design. Re-verify with a real client agent, not just `npm test`.
- **One blocking call at a time.** A second concurrent `human_ask`/`human_wait` returns
  immediately instead of queueing.
- **`bash` on Windows** needs a real bash on `PATH`; otherwise use `powershell`.
- **The listening ports must be free.** A taken port is a hard exit with a clear message,
  not a silent retry. Port 8765 is occupied by AgentDock on this machine, which is why the
  default moved to 8777. `npm run accept` asks the OS for free ports instead of guessing.
- **A quick-tunnel URL is printed before the edge connection exists, and you cannot trust an
  HTTP probe to tell you when it is ready.** On this machine a fake-IP TUN proxy makes the host
  unable to reach its own public URL at all (`ECONNRESET`, HTTP 000, or even `ENOTFOUND` — the
  proxy also intercepts DNS, so the symptom is not always a refused connection)
  while the tunnel is healthy for remote clients. `Registered tunnel connection` in
  cloudflared's log is the real signal; `pimcp` waits for that.
- **Git Bash ignores the Windows system proxy, so a push from this machine needs it spelled out.**
  Outbound 443 is blocked here and everything goes through FlClash on `127.0.0.1:7897` (Windows
  Internet Settings: `ProxyEnable=1`, `ProxyServer=127.0.0.1:7897`). Chrome and PowerShell pick that
  up automatically; `git` and `curl` in Git Bash do not, and fail with
  `Failed to connect to github.com port 443` and `curl: (28) Connection timed out` while `nslookup`
  resolves the right address — which reads like an outage rather than a missing proxy setting.
  `https_proxy=http://127.0.0.1:7897` on that one command is the fix. Same machine, same cause as the
  tunnel gotcha above: the proxy has to be up, and the host still cannot reach its own public URL
  through it.
- **Never spawn the server or cloudflared directly from the launcher.** They go through
  `bin/supervise.mjs`, which reaps them when the launcher dies. Verified: without it a hard
  kill of the launcher orphans the server *and* leaves an open public tunnel behind.
- **This machine already runs a `cloudflared` service** (automatic start, dashboard-managed
  tunnel, token in `C:\ProgramData\cloudflared\token`). A public hostname pointed at
  `127.0.0.1:8777` in the Zero Trust dashboard is stable across restarts — prefer it over a
  quick tunnel, whose hostname changes every time.
- **Security.** This bridge hands a remote model a shell on the host. `--root` confines path
  arguments only. Run it in a container with one mounted work directory, always set `--token`
  when using `--http`, and prefer `--approve`.

- **`var status` in the human UI silently did nothing, for the life of the file.** `window.status`
  is a legacy accessor whose setter coerces to a string, so the top-level
  `var status = document.getElementById('status')` stored `"[object HTMLSpanElement]"` and every
  later `status.textContent = …` was an assignment onto a primitive: dropped, no error. The pill
  never left "connecting…". Proven with a five-line jsdom repro, not reasoned about. Top-level
  `var` therefore must not shadow any `window` property — `scripts/ui-render-probe.mjs` now checks
  every declaration against a fresh window. (`let`/`const` shadow safely; only `var` is a hazard.)
- **`el.style.display = ''` does not show anything.** It removes the inline style, so the computed
  value falls back to the stylesheet — and `#countdown` carried `display:none` in its base rule. The
  countdown therefore shipped with the right text, at the right moment, permanently invisible, and a
  human had to be the one to notice. Show and hide with a class (`classList.toggle('hidden')`),
  never by clearing an inline style. `scripts/ui-render-probe.mjs` now asserts the *computed*
  display of every element the page toggles and fails on any `*.style.display = ''` in it. Checking
  `textContent` alone is exactly what let this through the first time.
- **`ui.html` is read on every request, so a styling change costs a browser refresh, not a
  restart.** It used to be `readFileSync` once at startup, which meant a CSS tweak meant restarting
  the bridge — and restarting `pimcp` rotates the quick-tunnel hostname *and* mints a new token, so
  a remote agent loses its connection mid-session. The page is served `no-store` for the same
  reason. `scripts/ui-probe.mjs` proves it by editing the real file, fetching, and restoring.
  Anything in `src/*.ts` still needs a restart.
- **One bubble, one look.** Messages carry a `kind` (`message`, `progress`, `done`, `error`, `note`,
  plus `question`/`waiting` from `human_ask`/`human_wait`) and it still drives the alerts, but it is
  deliberately *not* rendered: the page used to show a coloured badge and border per kind and it
  read as noise. "The agent is waiting for you" belongs in the status pill, the countdown and the
  chime, which are harder to miss than a border buried in the scrollback.
- **`human_ask`/`human_wait` hand over the whole queue, not one message.** They used to `shift()` a
  single item, so a human who typed three short lines had them delivered across three separate calls
  and the agent could act on an instruction the second line retracted. Everything queued since the
  last call now arrives in one result: one message verbatim, several merged oldest first as
  `[n/total · HH:MM:SS] text`, with `count` in the JSON. `scripts/channel-probe.mjs` pins it.
  Deliberately no settle window and no queue cap — the first message wakes a blocked call
  immediately and anything typed after that waits for the next call, and dropping a human's
  messages to protect a context window is the wrong trade.
- **The approval gate has to parse every line of a merged answer.** The tempting shortcut — give the
  gate only the first queued message — is *worse* than merging: `["yes", "no"]` would approve on the
  "yes" and silently discard the retraction. `approves()` in `src/server.ts` strips the queue
  prefixes and requires every line to match, so any retraction, or anything unrecognised, denies.
  The stripping is not cosmetic: the old `^`-anchored regex never matches a merged string because it
  starts with `[1/2 · `, so merging without stripping would deny every multi-message answer.
  `scripts/http-probe.mjs` drives yes+no, no+yes and yes+ok over real MCP traffic.
- **`/events` never closes.** Anything that reads it to completion blocks forever; the first
  version of `ui-probe` did exactly that and had to be killed. Read one frame and abort
  (`firstFrame` in `scripts/ui-probe.mjs`), or collect frames against an `AbortController`.
- **A literal `/vendor/../x` never reaches the traversal check.** The URL parser normalises it to
  `/x`, which 404s on its own. The cases worth testing are the encoded ones (`%2e%2e%2f`,
  `%2f`, `%5c`), which survive into `path.resolve` and must come back 403.
- **KaTeX's UMD build cannot be `require`d here.** The repository is `"type": "module"`, Node
  loads `katex.min.js` as ESM, and top-level `this` is `undefined` there, so the wrapper throws
  `Cannot set properties of undefined (setting 'katex')`. `eval` it into the jsdom window instead —
  which is also what a `<script src>` tag actually does.
- **The human UI is now a place where untrusted text becomes HTML.** Agent messages are markdown
  from a remote model, rendered by vendored marked and then reduced to a tag/attribute allowlist.
  That allowlist (`ALLOWED_TAGS`/`ALLOWED_ATTR`/`DROP_ENTIRELY` in `ui.html`) is a security
  boundary, not styling; `scripts/ui-render-probe.mjs` asserts against `<script>`, `<img>`, inline
  handlers and `javascript:` URLs. Do not loosen it to fix a rendering complaint without adding a
  case to that probe.

15. **The hot layer of the config file is applied, not diffed.** The watcher debounces bursts of UI saves into one read, so comparing against the previous read can miss a field that went A → B → A while the in-memory state still holds B. Every hot read sets the state from the file unconditionally (idempotent, always converging); `prev` is for the change log only. A UI reconnect of an upstream must also clear the `enabled: false` its disconnect wrote, or the next reconcile silently disconnects it again.
16. **The `/ctl` endpoints are as sensitive as the OAuth decision.** They move the sandbox root and turn the approval gate off, so they are refused while the human UI is reachable from off the machine with no token — enforced, not warned about. And the sandbox root never moves by agent request: there is deliberately no tool for it, only the human's hand on the web UI.
17. **Approval is one setting for every tool, upstreams included.** `--approve` still parses but means `approval.mode: "always"` — every call, `read` included, waits for a yes/no. A proxied upstream tool can be as much of a shell as `bash` is, so a per-tool list is a list that goes stale the moment a new tool is attached.

- **A tool-list change reaches the agent through its next tool result, once.** The stateless HTTP
  transport cannot send `tools/list_changed`, so `src/tool-watch.ts` compares the list with the last
  one the agent was given (a `tools/list` response, or an earlier notice) and appends a
  `[bridge notice]` to the next result. The baseline is process state, not per client: one client's
  `tools/list` clears the news for the others. `scripts/toolchange-probe.mjs` covers the path over
  real traffic: growth, a config reconnect, a removal, and a disconnected upstream.

- **A skill is read from its frontmatter one `key: value` per line.** A multi-line value (YAML `>` or `|`) reads as empty, so the skill is skipped and the reason goes to stderr once. Keep `name` and `description` on single lines. A description over 1024 characters is cut, because it goes into every instructions request.
