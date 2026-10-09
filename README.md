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
pimcp --human           # server + token + public tunnel, prints a paste-ready URL
```

`pimcp` roots the server at the **current directory**, picks free ports, mints a bearer
token, opens a Cloudflare quick tunnel, waits for cloudflared to register with the edge,
opens the human UI, and prints the MCP URL and token. Ctrl-C stops everything.
`pimcp --no-tunnel` keeps it on localhost; `pimcp --help` lists the rest.

**The human channel is off unless you pass `--human`.** Without it the bridge is a plain
tool surface: no web UI, no `human_say`/`human_ask`/`human_wait`, no `<human>` section in
the prompt, and no approval gate. That is the right shape for handing the bridge to
somebody who only wants the coding tools, and it is what the packaged build assumes.

Without the wrapper:

```bash
# local client (stdio), tools only
node src/index.ts --root /path/to/workdir

# remote client (HTTP). Point Arena at the printed URL.
node src/index.ts --root /path/to/workdir --http --port 8777 --token "$(openssl rand -hex 16)"

# with the human channel and a yes/no gate on shell commands
node src/index.ts --root /path/to/workdir --human --approve bash
```

Node 22.6+ is required: the sources are TypeScript and run directly via Node's type
stripping. There is no build step.

The default tool list is platform-aware: `powershell` is exposed on Windows only, because
Pi's PowerShell backend throws `only available on Windows` the moment it is called
anywhere else. Pass `--tools read,write,edit,ls,grep,find,bash,powershell` to override in
either direction.

### Pointing Arena at it

Arena is in the cloud, so it needs a public URL:

```bash
cloudflared tunnel --url http://127.0.0.1:8777
# then use:  https://<printed-host>/mcp
# header:    Authorization: Bearer <your --token>
```

Quick tunnels get a **new hostname every restart** — re-paste the URL each time. If you get
Cloudflare **error 1033 / HTTP 530**, you are pointing at a tunnel from a previous run.

## The human UI

`http://127.0.0.1:8790` is a single self-contained page — no CDN, no build step, and the
markdown and LaTeX libraries are vendored in `src/human/vendor/`, so it works with the
network off. **Only started with `--human`**; without that flag the port is never bound.

- **One timeline.** Agent messages, your messages, and every tool call the agent runs on
  this machine, in the order they happened. Tool rows are compact
  (`bash · echo hi · 42 ms · ✓`); click one to expand its output. Failed calls expand
  themselves. The toolbar hides all tool rows if you only want the conversation.
- **A runtime info panel** (`☰ info`): sandbox root, exposed tools, which tools need
  approval, the deny list, the wait window, uptime, the MCP endpoint, and whether the
  tokens are set. A port serving a shell with no token gets a red warning. Token *values*
  are never shown.
- **A countdown.** `human_ask`/`human_wait` block for `--block-ms` (90s by default) and
  then return `no_message`. The header shows the seconds left so you know whether to
  hurry.
- **Alerts.** `🔔` asks for notification permission and turns on a short chime — different
  tones for a question, a `done`, and an error — plus a flashing tab title. Off by default.
- Agent messages render as **markdown and LaTeX** (`$…$`, `$$…$$`, `\(...\)`, `\[...\]`).
  They come from a remote model, so the HTML they produce is reduced to a tag allowlist
  before it touches the page: raw HTML is displayed, never executed.

- **One bubble style.** Messages carry a category, but it is not printed on them — a chat does
  not have message types. The category still picks the alert sound.

`ui.html` is read on every request, so changing it costs a browser refresh, not a restart of
the bridge. Changes to `src/*.ts` still need a restart.

### The queue

Whatever you type while the agent is busy is queued, and its next `human_ask`/`human_wait` takes
**all of it** at once — oldest first, each line stamped `[n/total · HH:MM:SS]`. A single message
arrives verbatim. So three short lines are read as the one thought they are, and a retraction
arrives together with the message it retracts instead of a round trip later.

There is no settle window: the first message wakes a blocked call immediately, and anything typed
after that waits for the next call. There is no cap on the queue, and nothing is persisted, so a
restart clears it.

## Configuration

Flags take precedence over environment variables.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--root` | `PI_MCP_ROOT` | cwd | Sandbox root. Every path argument is confined here. |
| `--human` | `PI_MCP_HUMAN=1` | off | Expose the human channel: `human_say`/`human_ask`/`human_wait`, the web UI, the `<human>` prompt section, and the approval gate. |
| `--tools` | `PI_MCP_TOOLS` | 7 on Linux, 8 on Windows | Comma-separated subset to expose. `powershell` is Windows-only. |
| `--approve` | `PI_MCP_APPROVE` | none | Tools that require human approval, e.g. `bash`. **Needs `--human`**: with no human there is nobody to ask, so the bridge refuses to start instead of auto-approving. |
| `--deny` | `PI_MCP_DENY` | `.ssh,.aws,.gnupg,.git-credentials,.netrc,.config/gcloud` | Paths refused even inside the root. |
| `--block-ms` | `PI_MCP_BLOCK_MS` | 90000 | Max time `human_ask`/`human_wait` block before returning `no_message`. |
| `--http` | `PI_MCP_HTTP=1` | off | Serve Streamable HTTP instead of stdio. |
| `--port` / `--host` | `PI_MCP_PORT` / `PI_MCP_HOST` | 8777 / 127.0.0.1 | HTTP listener. A port already in use is a hard error, not a silent fallback. |
| `--token` | `PI_MCP_TOKEN` | none | Bearer token. **Set this if you expose the port.** |
| `--ui-port` / `--ui-host` | `PI_MCP_UI_PORT` / `PI_MCP_UI_HOST` | 8790 / 127.0.0.1 | Human web UI. Ignored without `--human`. |
| `--ui-token` | `PI_MCP_UI_TOKEN` | none | Token for the human UI. |

## Security

This bridge hands a remote model a shell on your machine. It is remote code execution by
design, so:

- **Run it in a container or VM, with only one work directory mounted.** `--root` confines
  path arguments, but a shell can still reach anything the process can.
- **Always set `--token` when using `--http`.** Without it the port is unauthenticated and
  the bridge logs a warning.
- **Use `--human --approve bash` (and `powershell`) if you want a gate.** Every shell command
  then blocks on a yes/no prompt in the human UI. It **fails closed**: no answer means denied.
  The gate needs `--human`, because with the human channel off there is nobody to ask — the
  bridge refuses to start rather than let `--approve` silently mean "allow".
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

## Shipping it to somebody else

`npm run package` produces a self-contained directory that runs on a machine with **no
Node, no npm, no cloudflared, and no network**:

```bash
npm run package           # for the machine you are on
npm run package:win       # dist/win32-x64   — cross-buildable from anywhere
npm run package:linux     # dist/linux-x64
```

```
dist/win32-x64/
  pimcp.cmd        double-click launcher (Windows)
  pimcp.sh         launcher (Linux/macOS)
  pimcp.mjs        the launcher that runs inside the package
  runtime/         the Node runtime — no npm/npx/corepack
  bin/             cloudflared, vendored
  app/
    index.mjs      the bridge, bundled by esbuild
    node_modules/  Pi's tool graph, pruned to what the bridge imports
    ui.html        the human UI page
    vendor/        marked + KaTeX, vendored
```

The recipient runs it from the directory the agent should own:

```
pimcp.cmd                          # Windows: tunnel + localhost, prints both URLs
./pimcp.sh                         # Linux
./pimcp.sh --human --approve bash  # with the human channel and a shell gate
```

Every flag the bridge understands works unchanged. On startup it prints an **MCP URL you
can paste into your client from anywhere on the internet**, plus the bearer token — that is
the whole "I run it on my machine, you connect from yours" flow. `--no-tunnel` keeps it on
localhost.

Four details worth knowing:

- **Pi's tool modules are deliberately not bundled.** `src/pi-tools.ts` imports them from
  `node_modules` at runtime, so their descriptions and JSON schemas always match the
  installed version. Bundling them would freeze them into the artifact.
- **The dependency tree is pruned by hand, not by a bundler.** Pi's own `node_modules`
  ships SDKs for Anthropic, Google, AWS and protobuf that this bridge never loads. What is
  kept is the set the tool graph actually imports, in the same locations npm put them —
  `chalk`, `diff`, `marked`, `typebox` and the `@earendil-works/*` core packages live
  *inside* Pi's nested `node_modules`, so hoisting them to the top level would break
  resolution. Verified by running the built artifact, not by guessing.
- **cloudflared is vendored, so a tunnel needs nothing installed.** It is copied from a
  local install when there is one (including from inside WSL when cross-building for
  Linux), and downloaded from the GitHub release otherwise. Without it the package still
  runs, just without a public URL, and the launcher says so.
- **Quick tunnels rotate their hostname on every restart.** The URL is printed each time,
  so re-paste it. For a stable hostname, run a named tunnel or a Zero Trust hostname
  instead — the bridge only ever needs `http://127.0.0.1:<port>/mcp`.

- **No single-file `.exe`.** A Node SEA would need the tool graph embedded, which is the
  same 150MB either way and loses the "descriptions cannot drift" property. A directory
  with a launcher is the honest shape for something that has to load a 143MB package.

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
