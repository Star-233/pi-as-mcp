# AGENTS.md

Index for agents working in this repository. The full manual lives in
[README.md](README.md) — read that before making non-trivial changes.

## What this is

`pi-mcp` is a **one-shot MCP bridge**. It gives a remote agent (typically a cloud model on a
model-arena platform) two things on the local machine:

1. Pi's coding tools — `read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`, `powershell`.
2. A human channel — `human_say`, `human_ask`, `human_wait`, surfaced in a local web page.

It is **not** an agent: there is no model and no loop. It is a tool surface plus a queue with
exactly one human in it. **No sessions, no persistence** — the process is meant to live for one
sitting.

The predecessor (HumanChat MCP, a Python broker + TUI + Web UI) was removed. It is preserved in
full, including the edits that were uncommitted at the time, at tag `humanchat-final`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point. Config, human UI, stdio or HTTP transport. |
| `src/pi-tools.ts` | Imports Pi's tool definitions and adapts them to MCP. |
| `src/prompt.ts` | Reproduces Pi's system-prompt algorithm, plus the `<human>` section. |
| `src/server.ts` | MCP server: tool list, human tools, approval gate. |
| `src/sandbox.ts` | Path containment + deny list. |
| `src/human/channel.ts` | In-memory single-human channel (the whole "session" story). Chat *and* tool-call entries share one ordered list. |
| `src/human/webui.ts`, `ui.html` | Local human UI (SSE + POST): timeline, runtime info panel, wait countdown, alerts. |
| `src/human/vendor/` | marked + KaTeX, copied from `node_modules` by `npm run vendor-ui`. Committed; the UI must work with no network. |
|`scripts/*.mjs`|Probes that drive the real server over real MCP traffic.|
|`scripts/package.mjs`|Builds `dist/<platform>-<arch>/`: bundled JS (Pi's tools inlined) + the UI assets + a Node runtime + cloudflared, so the recipient needs nothing installed.|
|`src/pi-tools-entry.ts`|The bundler seam for Pi's tool modules: a literal import the tsconfig alias can resolve, so esbuild inlines them into the artifact.|
|`bin/pimcp.mjs`|The `pimcp` launcher for a checkout: ports, token, tunnel (cloudflared on PATH), ready check, browser.|
|`bin/pimcp-packaged.mjs`|The launcher that ships *inside* `dist/`: bundled server + vendored cloudflared, no supervise.mjs, supervises its own child.|
| `scripts/channel-probe.mjs` | The queue semantics of the human channel: draining, ordering, stamps, the cap, the retraction case. |
| `scripts/ui-probe.mjs` | Drives the UI's HTTP surface: page, vendored assets, `/info`, `/health`, the SSE stream. Asserts; exits non-zero. |
| `scripts/ui-render-probe.mjs` | Runs the page's own inline script in jsdom against the vendored libs and asserts what it renders. |
| `bin/supervise.mjs` | Parent-death watchdog so children cannot outlive the launcher. |

## Commands

Run everything from the repository root. Node 22.6+ (sources are TypeScript, executed
directly via Node's type stripping — there is no build step).

```bash
npm install
npm test          # config defaults + stdio probe + HTTP/auth/approval probe + both UI probes
npm run typecheck # tsc --noEmit
npm run vendor-ui # re-copy marked + KaTeX into src/human/vendor
npm run prompt    # print the ported system prompt
npm run accept    # human acceptance: drives the real server, you reply in the browser
npm run package   # build a portable dist/<platform>-<arch>/ (needs network for the Node runtime)
npm link          # once: puts `pimcp` on PATH (run from anywhere afterwards)
pimcp             # server + token + tunnel for the current directory
pimcp --human     # ...and the human channel (off by default)

node src/index.ts --root <dir>                                  # stdio, tools only
node src/index.ts --root <dir> --human                          # stdio + human UI on :8790
node src/index.ts --root <dir> --http --port 8777 --token <tok> # for a remote client
```

## Invariants — do not regress these

1. **Pi's tools are never vendored by hand.** `src/pi-tools.ts` resolves the installed package and
   deep-imports `dist/core/tools/index.js`. Do not import the package root (it drags in the TUI
   and native image codecs) and do not copy the tool files into the repository — descriptions and
   schemas must not drift from the installed version. The *packaged artifact* does inline them,
   but through `src/pi-tools-entry.ts`, whose alias still points at the installed package, so the
   artifact is built from the same bytes the checkout runs.
2. **`buildSystemPrompt` is not exported from Pi.** `src/prompt.ts` reproduces the algorithm:
   preamble raw, every other section as `<name>…</name>`, rules via Pi's own ordering
   (per-tool guidelines in tool order → global guidelines → Pi's two closing rules).
3. **Stateless HTTP needs a fresh `Server` + transport per request.** The transport keeps
   per-session state; reusing one instance makes every request after `initialize` fail with 500.
4. **A sandbox rejection is a tool error, not a protocol error.** Path resolution must stay
   inside the `try` in `pi-tools.ts` so the client sees `isError`, not a JSON-RPC failure.
5. **Approval fails closed.** `--approve bash` with no human answer must deny, never run.
6. **stdout is the stdio protocol channel.** All logging goes to stderr.
7. **No sessions, no persistence.** Do not add a session id, a store, or a broker.

## Working conventions

Two habits this repository depends on, because its whole value is knowing which claims were
*actually* verified.

**Precipitate findings into this file, not into the chat.** Whenever a run proves something
surprising — a behaviour that contradicts the docs, a trap that costs an hour, a fix that was
confirmed — write it into **Gotchas** (or into an invariant, if it must never regress) **in the
same change**, with the evidence that proved it. A finding that lives only in a conversation is
lost the moment the context is compacted. Several entries below exist for exactly this reason,
and two of them replaced earlier entries that turned out to be wrong.

**Deliver changes as human-verifiable.** This repository is worked with the
`human-verifiable-change` skill (`~/.agents/skills/human-verifiable-change`). Automatic checks
passing is not the same as a human accepting the result. Every delivery states, in plain
language:

- **工作原理（白话）** — what the change does when it runs, and why.
- **AI已验证** — the exact commands run and their results, plus what they did *not* cover.
- **请人验收** — precondition → action → where to look → expected result.
- **未验证 / 风险** — what remains unproven, and the honest reason.
- **状态** — `待人类验收` until a human confirms it.

Never report a check as passing when it was not run, and never lower a check to make it green.
Ask before anything destructive or irreversible — deleting history, force-pushing, or exposing a
port to the internet.

## Gotchas

- **The human channel is off by default.** `--human` (or `PI_MCP_HUMAN=1`) turns on the
  `human_*` tools, the web UI, the `<human>` prompt section, and the approval gate as one
  unit — nothing may be half-on, because a model told about a tool it cannot call will call
  it. Verified over real stdio traffic: without the flag `tools/list` returns no `human_*`
  entries, the prompt contains no `<human>` section, and `human_say` returns an error
  naming the missing flag. Consequence for the probes: every script that exercises the
  channel passes `--human` explicitly.
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
  drifts from the checkout is worse than two files.
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
  unable to reach its own public URL at all (`ECONNRESET` / HTTP 000 for both curl and Node)
  while the tunnel is healthy for remote clients. `Registered tunnel connection` in
  cloudflared's log is the real signal; `pimcp` waits for that.
- **Never spawn the server or cloudflared directly from the launcher.** They go through
  `bin/supervise.mjs`, which reaps them when the launcher dies. Verified: without it a hard
  kill of the launcher orphans the server *and* leaves an open public tunnel behind.
- **This machine already runs a `cloudflared` service** (automatic start, dashboard-managed
  tunnel, token in `C:\ProgramData\cloudflared\token`). A public hostname pointed at
  `127.0.0.1:8777` in the Zero Trust dashboard is stable across restarts — prefer it over a
  quick tunnel, whose hostname changes every time.
- **Security.** This bridge hands a remote model a shell on the host. `--root` confines path
  arguments only. Run it in a container with one mounted work directory, always set `--token`
  when using `--http`, and prefer `--approve bash`.

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

## Open questions

- The LICENSE is still Apache-2.0 naming "HumanChat MCP contributors", from the removed project.
  It has not been changed deliberately.
- The project was promoted from the former `pi-mcp/` subdirectory to the repository root.
  Commits before that move and the `humanchat-final` tag name paths that no longer exist in
  the working tree; use `git log --follow` and `git show humanchat-final --stat`.
