# pi-mcp

A one-shot MCP bridge that gives a **remote** agent two things on **your** machine:

1. **Pi's coding tools** — read, write, edit, ls, grep, find, bash, powershell.
2. **A human channel** — the agent talks to you through tool calls, not through the host
   platform's chat UI.

Built for the Arena case: the agent runs in the cloud, you point it at this bridge, and it
works on your computer. Talking through tool calls keeps **one model and one context**
across the whole session and avoids the platform's chat round-trip.

There are **no sessions and no persistence**. This process is meant to live for one sitting;
"state" is a single in-memory message list.

**→ Agent index: [AGENTS.md](AGENTS.md)** — read that before making non-trivial changes.

## What it exposes

| Tool | Source | Notes |
|---|---|---|
| `read` `write` `edit` `ls` `grep` `find` `bash` `powershell` | Pi, verbatim | Descriptions, JSON schemas and prompt metadata come from Pi at runtime |
| `human_say` | this repo | Agent → human, returns immediately |
| `human_ask` | this repo | Ask and block until answered |
| `human_wait` | this repo | Block until the human says anything |
| `get_instructions` | this repo | Returns the operating prompt verbatim |

The full operating prompt is also sent as the MCP `instructions` field on `initialize`,
and exposed as an MCP prompt named `pi_mcp_instructions`.

## Architecture

```
Arena / any MCP client (cloud)
        │  Streamable HTTP + Bearer   (or stdio)
        ▼
   pi-mcp  ──────────────►  Pi tool definitions  (imported, not copied)
      │                         │
      │                         └─► your filesystem / shell, confined to --root
      │
      └─► human channel (in-memory) ──SSE──►  http://127.0.0.1:8790  (your browser)
```

The bridge is **not** an agent. It has no model and no loop: the cloud agent is the only
agent. This process is a tool surface plus a message queue with exactly one human in it.

## Quickstart

```bash
npm install
npm link                # puts the `pimcp` command on your PATH — once

cd /path/to/workdir     # the directory the agent should own
pimcp                   # server + token + public tunnel, prints a paste-ready URL
```

`pimcp` roots the server at the **current directory**, picks free ports, mints a bearer
token, opens a Cloudflare quick tunnel, waits for cloudflared to register with the edge,
opens the human UI, and prints the MCP URL and token. Ctrl-C stops everything.
`pimcp --no-tunnel` keeps it on localhost; `pimcp --help` lists the rest.

Without the wrapper:

```bash
# local client (stdio). Human UI comes up on 127.0.0.1:8790 — open it.
node src/index.ts --root /path/to/workdir

# remote client (HTTP). Point Arena at the printed URL.
node src/index.ts --root /path/to/workdir --http --port 8777 --token "$(openssl rand -hex 16)"
```

Node 22.6+ is required: the sources are TypeScript and run directly via Node's type
stripping. There is no build step.

### Pointing Arena at it

Arena is in the cloud, so it needs a public URL:

```bash
cloudflared tunnel --url http://127.0.0.1:8777
# then use:  https://<printed-host>/mcp
# header:    Authorization: Bearer <your --token>
```

Quick tunnels get a **new hostname every restart** — re-paste the URL each time. If you get
Cloudflare **error 1033 / HTTP 530**, you are pointing at a tunnel from a previous run.

## Configuration

Flags take precedence over environment variables.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--root` | `PI_MCP_ROOT` | cwd | Sandbox root. Every path argument is confined here. |
| `--tools` | `PI_MCP_TOOLS` | all 8 | Comma-separated subset to expose. |
| `--approve` | `PI_MCP_APPROVE` | none | Tools that require human approval, e.g. `bash`. |
| `--deny` | `PI_MCP_DENY` | `.ssh,.aws,.gnupg,.git-credentials,.netrc,.config/gcloud` | Paths refused even inside the root. |
| `--block-ms` | `PI_MCP_BLOCK_MS` | 90000 | Max time `human_ask`/`human_wait` block before returning `no_message`. |
| `--http` | `PI_MCP_HTTP=1` | off | Serve Streamable HTTP instead of stdio. |
| `--port` / `--host` | `PI_MCP_PORT` / `PI_MCP_HOST` | 8777 / 127.0.0.1 | HTTP listener. A port already in use is a hard error, not a silent fallback. |
| `--token` | `PI_MCP_TOKEN` | none | Bearer token. **Set this if you expose the port.** |
| `--ui-port` / `--ui-host` | `PI_MCP_UI_PORT` / `PI_MCP_UI_HOST` | 8790 / 127.0.0.1 | Human web UI. |
| `--ui-token` | `PI_MCP_UI_TOKEN` | none | Token for the human UI. |

## Security

This bridge hands a remote model a shell on your machine. It is remote code execution by
design, so:

- **Run it in a container or VM, with only one work directory mounted.** `--root` confines
  path arguments, but a shell can still reach anything the process can.
- **Always set `--token` when using `--http`.** Without it the port is unauthenticated and
  the bridge logs a warning.
- **Use `--approve bash` (and `powershell`) if you want a gate.** Every shell command then
  blocks on a yes/no prompt in the human UI. It **fails closed**: no answer means denied.
- **Rotate the token per sitting.** For one-shot use, quick tunnels that change hostname are
  fine — they expire on their own.
- Tool output (file contents, command output) transits the remote platform and may be logged
  there.

## How Pi's prompt and tools were ported

Both are taken from `@earendil-works/pi-coding-agent@1.0.0` (MIT) **at runtime**, so they
cannot drift:

- **Tools.** The package's root export drags in the TUI and native image codecs, and it has no
  subpath export for the tool modules. So `src/pi-tools.ts` resolves the package directory
  and imports `dist/core/tools/index.js` directly, then calls
  `createAllToolDefinitions(cwd, …)`. Only that module graph loads. Descriptions, JSON
  schemas, `promptSnippet` and `promptGuidelines` are used as-is; TypeBox emits plain JSON
  Schema, which is what MCP wants.
- **Prompt.** `buildSystemPrompt` is not exported, so `src/prompt.ts` reproduces Pi's
  algorithm from `core/system-prompt.ts`: the preamble stays raw, every other section is
  rendered as `<name>…</name>`, and the rules list is built by `buildRules()` — per-tool
  guidelines in tool order, then global guidelines, then Pi's two closing rules.

Adapted deliberately:

- The preamble says you reach a *remote* machine through a bridge rather than claiming to run
  inside Pi.
- Pi's `docs` and `skills` sections are dropped: they point at Pi's local documentation and
  there is no Pi session here.
- The `<human>` section is new. It replaces humanchat's per-call "MANDATORY RULES" block,
  which was appended to every tool result; the rules are stated once, in the prompt — **with one
  deliberate exception**. A `no_message` result leads with a plain sentence telling the model to
  call again, because stating the rule only in the prompt did not hold a real client agent in the
  wait loop. See the gotcha below.
- Shell session variables (`PI_SESSION_ID`, `PI_MODEL`, …) are switched off via
  `exposeSessionEnvironment: false`, since there is no session; this also drops the
  guideline telling the model to read them.

## Tests

```bash
npm test        # config defaults, stdio round-trip, HTTP round-trip + approval gate
npm run typecheck
npm run accept  # end-to-end human acceptance; you reply in the browser
```

The probes spawn the real server and assert on real MCP traffic, including that a sandbox
escape is refused and that an unapproved shell command never runs.

## Gotchas

- **Blocking over a tunnel.** `human_ask`/`human_wait` hold the HTTP request open. Cloudflare
  drops a silent origin after ~100s, which is why the default cap is 90s. Raising
  `--block-ms` past that risks a 524; the call also emits MCP progress notifications every
  20s to keep the stream warm when the client supplies a progress token.
- **`no_message` is not an error.** It means the human did not answer within the window. The
  prompt instructs the model to call `human_wait` again. A model that ignores this will end
  its turn early.
- **One blocking call at a time.** A second concurrent `human_ask`/`human_wait` returns
  immediately with `no_message` rather than queueing.
- **Stateless HTTP.** A fresh `Server` + transport is created per request. Reusing one
  transport makes every request after `initialize` fail with HTTP 500.
- **`bash` on Windows** needs a real bash on `PATH`; use `powershell` otherwise.
- **Do not judge a tunnel by knocking on its URL.** A local VPN or proxy (fake-IP TUN) can
  leave your own machine unable to reach its own public URL — `ECONNRESET`, or HTTP 000 from
  curl — while the tunnel is perfectly healthy for remote clients. The reliable signal is
  cloudflared logging `Registered tunnel connection`; `pimcp` waits for exactly that and then
  reports the local probe as advisory only.
- **A model will happily end its turn on a `no_message`.** Observed with a real client agent:
  it called `human_wait` once, read `no_message`, and ended the conversation — silently dropping
  the human, which is the exact failure this bridge exists to prevent. Prompt-only instruction was
  not enough, so a `no_message` result now leads with an imperative sentence and the `<human>`
  section names the failure mode outright ("your turn must not end while you are waiting"). If you
  touch either, re-test with a real client agent — `npm test` cannot catch this.
- **Port 8765 is taken by AgentDock on this machine**, which is why the HTTP default is 8777.

## History

This repository previously contained **HumanChat MCP**, a Python human-in-the-loop MCP
server (broker + TUI + Web UI). It was replaced by `pi-mcp`; that code was removed from the
working tree. The old implementation, including the edits that were uncommitted at the time
of removal, is preserved at tag **`humanchat-final`**:

```bash
git show humanchat-final --stat
git checkout humanchat-final -- src/humanchat/webui_assets.py   # recover a single file
```

The former `pi-mcp/` subdirectory was promoted to the repository root; `git log --follow`
crosses that move.
