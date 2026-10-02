# AGENTS.md

Index for agents working in this repository. The full manual lives in
[pi-mcp/README.md](pi-mcp/README.md) — read that before making non-trivial changes.

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
| `pi-mcp/src/index.ts` | Entry point. Config, human UI, stdio or HTTP transport. |
| `pi-mcp/src/pi-tools.ts` | Imports Pi's tool definitions and adapts them to MCP. |
| `pi-mcp/src/prompt.ts` | Reproduces Pi's system-prompt algorithm, plus the `<human>` section. |
| `pi-mcp/src/server.ts` | MCP server: tool list, human tools, approval gate. |
| `pi-mcp/src/sandbox.ts` | Path containment + deny list. |
| `pi-mcp/src/human/channel.ts` | In-memory single-human channel (the whole "session" story). |
| `pi-mcp/src/human/webui.ts`, `ui.html` | Local human UI (SSE + POST). |
| `pi-mcp/scripts/*.mjs` | Probes that drive the real server over real MCP traffic. |

## Commands

Run everything from `pi-mcp/`. Node 22.6+ (sources are TypeScript, executed directly via
Node's type stripping — there is no build step).

```bash
npm install
npm test          # config defaults + stdio probe + HTTP/auth/approval probe
npm run typecheck # tsc --noEmit
npm run prompt    # print the ported system prompt

node src/index.ts --root <dir>                                  # stdio + human UI on :8790
node src/index.ts --root <dir> --http --port 8765 --token <tok> # for a remote client
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

## Gotchas

- **Cloudflare drops a silent origin after ~100s.** That is why the human block cap defaults to
  90s. Raising `--block-ms` past that risks a 524 before the human answers.
- **Quick tunnels rotate hostnames on every restart.** A stale URL gives Cloudflare error
  1033 / HTTP 530 — it does not mean the server is down.
- **`human_ask`/`human_wait` may return `no_message`.** That is a "the human has not spoken yet"
  signal, not a failure. The prompt tells the model to call again; a model that ignores this
  will end its turn early.
- **One blocking call at a time.** A second concurrent `human_ask`/`human_wait` returns
  immediately instead of queueing.
- **`bash` on Windows** needs a real bash on `PATH`; otherwise use `powershell`.
- **Security.** This bridge hands a remote model a shell on the host. `--root` confines path
  arguments only. Run it in a container with one mounted work directory, always set `--token`
  when using `--http`, and prefer `--approve bash`.

## Open questions

- The LICENSE is still Apache-2.0 naming "HumanChat MCP contributors", from the removed project.
  It has not been changed deliberately.
- `pi-mcp/` has not been promoted to the repository root; the README at the root is an
  orientation page pointing at `pi-mcp/README.md`.
