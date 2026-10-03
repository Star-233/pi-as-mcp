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
| `scripts/*.mjs` | Probes that drive the real server over real MCP traffic. |
| `scripts/ui-probe.mjs` | Drives the UI's HTTP surface: page, vendored assets, `/info`, `/health`, the SSE stream. Asserts; exits non-zero. |
| `scripts/ui-render-probe.mjs` | Runs the page's own inline script in jsdom against the vendored libs and asserts what it renders. |
| `bin/pimcp.mjs` | The `pimcp` launcher: ports, token, tunnel, ready check, browser. |
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
npm link          # once: puts `pimcp` on PATH (run from anywhere afterwards)
pimcp             # server + token + tunnel for the current directory

node src/index.ts --root <dir>                                  # stdio + human UI on :8790
node src/index.ts --root <dir> --http --port 8777 --token <tok> # for a remote client
```

## Invariants — do not regress these

1. **Pi's tools are imported, not copied.** `src/pi-tools.ts` resolves the package directory and
   deep-imports `dist/core/tools/index.js`. Do not import the package root (it drags in the TUI
   and native image codecs) and do not vendor the tool files — descriptions and schemas must not
   drift from the installed version.
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
- **`ui.html` is read once, at startup.** `startWebUI` does `fs.readFileSync` before listening, so
  editing the page does nothing to a running bridge. Restart it — and a restart of `pimcp` rotates
  the quick-tunnel hostname and the token, so a remote agent loses its connection.
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
