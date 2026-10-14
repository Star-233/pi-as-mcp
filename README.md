# pi-as-mcp

A one-shot MCP bridge that gives a **remote** agent two things on **your** machine:

1. **Pi's coding tools** — read, write, edit, ls, grep, find, bash, powershell.
2. **A human channel** — the agent talks to you through tool calls, not through the host
   platform's chat UI.

Built for the Arena case: the agent runs in the cloud, you point it at this bridge, and it
works on your computer. Talking through tool calls keeps **one model and one context**
across the whole session and avoids the platform's chat round-trip.

There are **no sessions and no persistence**. This process is meant to live for one sitting;
"state" is a single in-memory message list. That goes for authorization too: a client that
outlives a restart simply authorizes again.

The command is `pimcp` (the project's short name). Run it from the directory the agent
should own.

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
and exposed as an MCP prompt named `pi_as_mcp_instructions`.

## Architecture

```
Arena / any MCP client (cloud)
        │  Streamable HTTP + Bearer   (or stdio)
        ▼
   pi-as-mcp  ──────────────►  Pi tool definitions  (imported, not copied)
      │  ▲                        │
      │  │                        └─► your filesystem / shell, confined to --root
      │  └── OAuth 2.1 (--oauth): discovery, registration, PKCE, tokens
      │
      └─► human channel (in-memory) ──SSE──►  http://127.0.0.1:8790  (your browser)
                  ▲
                  └── where an authorization is approved, by hand
```

The bridge is **not** an agent. It has no model and no loop: the cloud agent is the only
agent. This process is a tool surface plus a message queue with exactly one human in it.

## Quickstart

```bash
npm install
npm link                # puts the `pimcp` command on your PATH — once

cd /path/to/workdir     # the directory the agent should own
pimcp                   # server + token + public tunnel + OAuth, prints a paste-ready URL
pimcp --human           # ...and the human channel, so the agent can talk to you
pimcp --no-oauth        # ...without the authorization server (the client needs the token)
```

## The configuration file

`~/.pimcp/config.json` (moved with `PI_AS_MCP_CONFIG`) is one place for everything a run can
be steered by. A flag given on the command line beats the file; the file beats the defaults.

```json
{
  "human": true,
  "approval": { "mode": "always" },
  "mcps": {
    "github": { "type": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"] },
    "remote": { "type": "http", "url": "https://host.example/mcp", "headers": { "Authorization": "Bearer …" } }
  },
  "tunnel": {
    "enabled": true,
    "mode": "named", "hostname": "mcp.example.com",
    "name": "my-tunnel", "credentialsFile": "C:/.../tunnel-credentials.json"
  }
}
```

- **`human`** turns the human channel on, like `--human`.
- **`approval`** is one setting for every tool: `"always"` holds each call — `read` included,
  and upstream tools too — for a yes/no in the web UI; `"never"` lets everything run. It needs
  the human channel on; that combination is refused rather than auto-approving. (`--approve`
  still works and means `"always"`.)
- **`mcps`** are other MCP servers, attached as upstreams at startup. Their tools appear with
  the upstream's name as a prefix (`github_list`), behind the same approval gate and timeline
  as the local ones. An entry with `"enabled": false` stays configured but disconnected.
- **`tunnel`** picks the quick tunnel (random hostname, the default) or **a named tunnel with
  your own hostname**: give `name` + `credentialsFile` (route its DNS once with
  `cloudflared tunnel route dns`) or `token` (a dashboard-managed tunnel, whose ingress points
  at `http://localhost:8777`), plus `hostname`.

The file is watched: `human`, `approval` and `mcps` apply to a running bridge without a
restart, and the same controls exist as buttons in the web UI. The tunnel layer is
restart-only — the log says so when it changes.

### Steering a running bridge from the web UI

The sidebar has a **controls** section (loopback UIs, or any UI with a token): switch the
sandbox root to another directory, flip the human channel or the approval mode, and connect /
disconnect upstream MCP servers or add new ones. Every action writes back to the config file,
so an editor and the UI cannot drift apart. A UI that is reachable from off the machine with
no token serves none of the control endpoints — the same rule that governs OAuth approvals.
Moving the root is deliberately a human-only action: the agent has no tool for it.

`pimcp` roots the server at the **current directory**, picks free ports, mints a bearer
token, opens a Cloudflare quick tunnel, waits for cloudflared to register with the edge,
opens the web UI, and prints the MCP URL and token. Ctrl-C stops everything.
`pimcp --no-tunnel` keeps it on localhost; `pimcp --help` lists the rest.

**OAuth is on by default**, so a client that speaks MCP's authorization flow needs nothing
but the printed URL: it discovers the authorization server, asks for access, and you approve
it in the UI. The same startup also mints and prints a client id and secret, for a product
that wants them pasted into it instead (Gemini's "custom connected app"). A client that
cannot do OAuth still has the bearer token. `--no-oauth` removes the authorization server
entirely.

**The human channel is off unless you pass `--human`.** Without it the agent gets no
`human_say`/`human_ask`/`human_wait` and no `<human>` section in the prompt. The UI still
runs whenever `--oauth` is on, because that is where an authorization is approved — it just
has no composer and no conversation in it.

Without the wrapper:

```bash
# local client (stdio), tools only
node src/index.ts --root /path/to/workdir

# remote client (HTTP). Point Arena at the printed URL.
node src/index.ts --root /path/to/workdir --http --port 8777 --token "$(openssl rand -hex 16)"

# with the human channel and a yes/no gate on shell commands
node src/index.ts --root /path/to/workdir --human --approve bash

# with an authorization server in front of it (the human channel is not required)
node src/index.ts --root /path/to/workdir --http --oauth \
  --issuer https://mcp.example.com
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

## OAuth

`--oauth` turns the bridge into its own OAuth 2.1 authorization server, so a client
can be given access **without you copying a token into it**. The bearer token keeps
working at the same time, for clients that cannot do OAuth. `pimcp` turns OAuth on by
default; `--no-oauth` goes back to a token-only bridge.

Which of the two shapes below applies is decided by the client, not by you.

### A client that registers itself

A spec-shaped MCP client does this without being asked:

1. It calls `/mcp`, gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
2. It fetches `/.well-known/oauth-protected-resource/mcp`, then
   `/.well-known/oauth-authorization-server`.
3. It registers itself at `/register` (dynamic client registration, RFC 7591) and sends
   its browser to `/authorize` with a PKCE `code_challenge`.
4. **That page has no buttons.** It names the client and where it wants to redirect, and
   says to approve on your own machine. It then waits.
5. The request appears as a card in the bridge UI — client name, redirect target, scope —
   with **Allow** and **Deny**. Nothing happens until you click one.
6. Allow: the browser is handed a one-shot code and redirected back. The client exchanges
   it at `/token` for an access token (12h) and a refresh token (30d).

### A client you configure by hand: Gemini's "custom connected app"

A hosted product asks *you* for a client id and a client secret, and shows you — behind a
button, in the same dialog — the redirect URI it will use. Such a client never registers
itself and never learns that this bridge's scope is called `mcp`.

Plain `pimcp` is enough. It mints a credential pair on every run and prints it:

```
  Client credentials — paste these into the client's own OAuth settings. The redirect URI
  is whatever that client tells you it wants; paste it back there, and the first time it
  asks, the card on the approval page names it and your Allow is what permits it.
      client id      pimcp-h05-kLnEyqe0
      client secret  1lrdVL8ehejLeu10VhXx-ADW3xWnwFpVM2Hsy8AjpGY
```

Paste the id and secret into the dialog (**客户端 ID** / **客户端密钥**) and continue in it.
You do not have to name the redirect URI in advance, and that is not a shortcut: the product
tells you the address *after* the bridge is already running, so there was never a moment at
which it could have been registered. When the client finally asks, it waits as a card on the
bridge UI like any other request — with the address it named printed on the card, under a
line that says what your click is about to mean:

> That address was not set up in advance — the client sent it just now, and allowing is
> what allows it (for this run only).

**Allow** is what permits that address, and the only thing that does. Approving also records
it for the rest of the run, so the same address is not flagged again — but a *different*
address from the same client is flagged again, because the permission is per address, not
per client. A client with **no** secret gets no such path at all: it must use PKCE and one of
its registered URIs, since its code has nothing else protecting it.

If you would rather have the strict shape — addresses named up front, anything else refused
outright — name them yourself, and the credentials are then printed beside them:

```bash
pimcp --oauth-redirect https://oauth-redirect.googleusercontent.com/r/<your-app>
```

```
      client id      pimcp-ZhySNFlK2i04
      client secret  PAootb1Kkdx75D6ATZxTQoAJ2icfeF3RQzY0xTw-rNM
      redirects to   https://oauth-redirect.googleusercontent.com/r/<your-app>
```

Those credentials are minted fresh on every run, because nothing here is persisted. To keep
a pair across restarts — which is what you want, since the client already holds it — pin
both, with or without `--oauth-redirect`:

```bash
pimcp --oauth-client-id pimcp-gemini --oauth-client-secret "$(openssl rand -base64 32)"
```

**What a hand-configured client may do differently**, and why:

- **Skip PKCE.** Its client secret is what protects the authorization code — the arrangement
  RFC 6749 §4.1 described before PKCE existed — and the code only goes to its address or to
  one you approved. A client *without* a secret must use PKCE S256: that is what the MCP
  specification requires, and it is the only thing protecting its code. A public client that
  skips PKCE is turned away with `invalid_request`.
- **Send its secret in the body or as HTTP Basic.** Which of the two a hosted client
  chooses is not this bridge's decision to make.

What it may **not** do: get a token without your click, or get one at all without its
secret. `--oauth-redirect` replaces the registration step, not the human.

A scope the bridge does not have is **narrowed to `mcp` rather than refused** (RFC 6749
§3.3 permits issuing less than was requested). A hosted client asks for whatever its own
platform taught it to ask for — `openid`, say — and has no way to find out otherwise. The
consent page states what was asked for and what will actually be granted.

**The decision lives on the bridge UI on purpose.** The page at `/authorize` is served
from whatever address the client reached — over a quick tunnel, that is the open internet
— and a button there would be an authorization any stranger who found the URL could click.
The UI is bound to loopback and can carry `--ui-token`; a page that only you can open is
the only kind that can be allowed to hand away a shell. Note that this is why `--oauth`
starts the UI: the page carrying Allow/Deny is not something you have to want to *converse*
with an agent to need. Without `--human` you get the UI as an approval console and nothing
else — no `human_say`/`human_ask`/`human_wait`, no composer in the page.

Requests wait 10 minutes for you and then expire; at most 8 may be pending at once. Everything
is in memory: tokens, registered clients and pending requests all die with the process, so a
restart means the client authorizes again.

**Reachability is the whole game.** The authorization server advertises exactly one `issuer`
(`--issuer`, or the quick-tunnel hostname, or `http://127.0.0.1:<port>`), and a client checks
it against the address it actually reached. So the URL you give the client has to be the URL
the bridge is reachable at, and it must be `https` — except for a loopback address, which is
allowed unencrypted for local use. The bridge logs the issuer it chose, and warns when that is
a loopback address a remote client cannot use. A stable Zero Trust hostname is a better fit
here than a quick tunnel, whose hostname changes every restart.

## The human UI

`http://127.0.0.1:8790` is a single self-contained page — no CDN, no build step, and the
markdown and LaTeX libraries are vendored in `src/human/vendor/`, so it works with the
network off. It runs with `--human`, and with `--oauth` (where it is only an approval
console: no composer, no conversation). Without either flag the port is never bound.

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
- **Authorization cards.** With `--oauth`, a client asking for access appears above the
  timeline — not in it, because it is not something the agent said — with **Allow** and
  **Deny**. It stays until you answer or it expires in 10 minutes, and it chimes like a
  question. The client's name is shown as text, never as markup: it chose that name itself.
- **What ran on this machine.** Tool calls are listed whenever the UI is up, including the
  `--oauth`-only case. Watching a client work while you decide whether to trust it is the
  point of having the page there at all.

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

Flags take precedence over environment variables. Environment variables all carry the
`PI_AS_MCP_` prefix, after the project's name. The **defaults below are the server's**;
`pimcp` deliberately differs on one of them (it turns `--oauth` on) and says so in the
table row.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--root` | `PI_AS_MCP_ROOT` | cwd | Sandbox root. Every path argument is confined here. |
| `--human` | `PI_AS_MCP_HUMAN=1` | off | Expose the human channel: `human_say`/`human_ask`/`human_wait` and the approval gate. The web UI comes with it, but is not exclusive to it — `--oauth` starts the UI too. |
| `--tools` | `PI_AS_MCP_TOOLS` | 7 on Linux, 8 on Windows | Comma-separated subset to expose. `powershell` is Windows-only. |
| `--approve` | `PI_AS_MCP_APPROVE` | none | Approval mode `"always"`: **every** tool call waits for a yes/no in the web UI (the tool list a value used to name is now ignored — one setting covers everything, upstreams included). **Needs `--human`**: with no human there is nobody to ask, so the bridge refuses to start instead of auto-approving. |
| `--deny` | `PI_AS_MCP_DENY` | `.ssh,.aws,.gnupg,.git-credentials,.netrc,.config/gcloud` | Paths refused even inside the root. |
| `--block-ms` | `PI_AS_MCP_BLOCK_MS` | 90000 | Max time `human_ask`/`human_wait` block before returning `no_message`. |
| `--http` | `PI_AS_MCP_HTTP=1` | off | Serve Streamable HTTP instead of stdio. |
| `--port` / `--host` | `PI_AS_MCP_PORT` / `PI_AS_MCP_HOST` | 8777 / 127.0.0.1 | HTTP listener. A port already in use is a hard error, not a silent fallback. |
| `--token` | `PI_AS_MCP_TOKEN` | none | Bearer token. **Set this if you expose the port**, unless you use `--oauth`. |
| `--oauth` | `PI_AS_MCP_OAUTH=1` | off (**on in `pimcp`**) | Serve an OAuth 2.1 authorization server in front of `/mcp`, and run the UI that approves it. **Needs `--http`.** |
| `--issuer` | `PI_AS_MCP_ISSUER` | the tunnel hostname, else `http://127.0.0.1:<port>` | The URL clients reach, and the identity the authorization server advertises. Only with `--oauth`. Must be `https`, or a loopback `http` address. |
| `--oauth-redirect` | `PI_AS_MCP_OAUTH_REDIRECT` | none | The addresses a hand-configured client may return to (comma-separated), named before it ever asks. **Without this the address is not known in advance**: the first one the client sends is shown on the approval card, and your click is what allows it. Only with `--oauth`. |
| `--oauth-client-id` / `--oauth-client-secret` | `PI_AS_MCP_OAUTH_CLIENT_ID` / `…_SECRET` | minted per run | Use this credential pair instead of minting one, so a restart does not invalidate a pair a client already holds. Both together, and only with `--oauth`. |
| `--ui-port` / `--ui-host` | `PI_AS_MCP_UI_PORT` / `PI_AS_MCP_UI_HOST` | 8790 / 127.0.0.1 | The web UI. Runs with `--human` or `--oauth`; ignored without either. |
| `--ui-token` | `PI_AS_MCP_UI_TOKEN` | none | Token for the UI. **Set it if you bind the UI to anything but loopback** — with `--oauth`, the UI is what can grant access here. |

## Project instructions and skills

**Project instructions.** `AGENTS.md` (or `CLAUDE.md`, where a directory has no `AGENTS.md`) goes into the instructions the agent is given. The bridge reads `~/.pimcp/AGENTS.md` first, then each directory from the git root down to `--root`. Nearer files come last and take precedence. A file over 64 KB is cut and marked. An edit reaches the agent once, as a notice on its next tool result, and `get_instructions` returns the current text.

**Skills.** A skill is a directory with a `SKILL.md` whose frontmatter has a `name` and a `description`, both required. The bridge reads skills from, least specific first:

1. its built-in skills (`builtin-skills/`, which holds `pimcp`: how to configure the bridge itself);
2. `~/.agents/skills`;
3. `.agents/skills`, `.claude/skills` and `.pi/skills` in each directory from the git root down to `--root`.

A nearer directory wins over a farther one, and a project skill wins over a global one with the same name. The agent is given each skill's name, description and address, `skill://<name>/SKILL.md`, and reads it with `read`. Files inside a skill are `skill://<name>/<file>`. Those addresses are read-only and cannot leave their skill directory, symlinks included. A skill that breaks these rules is skipped, and the reason goes to stderr once. Frontmatter is read one `key: value` per line, and a description over 1024 characters is cut.

The bridge only reads these directories. The built-in skills are served by the bridge alone and are never copied into another agent's directory.

## Security

This bridge hands a remote model a shell on your machine. It is remote code execution by
design, so:

- **Run it in a container or VM, with only one work directory mounted.** `--root` confines
  path arguments, but a shell can still reach anything the process can.
- **The shell guard refuses a short list of destructive command lines** in every approval mode: a recursive delete of a root, a home or the working directory, a disk format, a shutdown, a boot-configuration or registry-hive wipe. It reads the text of a command, so it catches mistakes, not a determined caller. `--root` and the deny list apply to the file tools only; `bash` and `powershell` can reach any path.
- **Always set `--token` when using `--http`, unless you are using `--oauth`.** Without either,
  the port is unauthenticated and the bridge logs a warning.
- **With `--oauth`, the web UI is the authorization authority.** Keep it on loopback, or set
  `--ui-token`. A UI that others can reach with no token is a way for them to authorize
  themselves; the bridge warns and the info panel calls it out.
- **A hand-configured client's secret is a credential you now have to keep.** It is printed
  once per run unless you pin it with `--oauth-client-id`/`--oauth-client-secret`; anyone who
  reads it can ask for access, but still cannot get a token without your click.
- **Approving an address you were not expecting is the one decision worth slowing down on.**
  A confidential client's callback address only has to be approved by you once, and the card
  says so in as many words — but if you did not just start that client, the address on the
  card is somebody else's, and Allow sends them a code. Their secret is still required to
  turn it into a token, which is why this is a warning and not a refusal; a client with no
  secret gets no such path at all.
- **An OAuth access token is a shell until it expires** (12h, refreshable for 30 days or until
  the process ends). Denying a request that has not been answered yet is the only way to
  refuse — once granted, the way to take it back is to restart the bridge. Keep the run short;
  that is what this process is for.
- **Use `--human --approve` if you want a gate on every call.** Every tool call then blocks on
  a yes/no prompt in the human UI — all of them, `read` included, upstream MCP tools too: one
  setting, no per-tool list to keep complete. It **fails closed**: no answer means denied. The
  gate needs `--human`, because with the human channel off there is nobody to ask — the bridge
  refuses to start rather than let `--approve` silently mean "allow".
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
    index.mjs      the bridge *and Pi's tools*, bundled — ~3.1MB
    node_modules/  only Pi's lazy image-resize wasm — everything else is in the
                   bundle
    ui.html        the human UI page
    vendor/        marked + KaTeX, vendored
```

The recipient runs it from the directory the agent should own:

```
pimcp.cmd                          # Windows: tunnel + localhost, prints both URLs
./pimcp.sh                         # Linux
./pimcp.sh --human --approve       # with the human channel and an approval gate
```

Every flag the bridge understands works unchanged. On startup it prints an **MCP URL you
can paste into your client from anywhere on the internet** — and because `--oauth` is on by
default, a client that speaks the authorization flow needs nothing else. A bearer token is
printed too, for clients that cannot do OAuth. That is the whole "I run it on my machine, you
connect from yours" flow. `--no-tunnel` keeps it on localhost, `--no-oauth` drops the
authorization server.

Four details worth knowing:

- **Pi's tools are bundled into `index.mjs`, but only in the artifact.** `src/pi-tools.ts`
  resolves Pi's tool entry at runtime, because Pi's `exports` map has no subpath for
  `dist/core/tools/*` and Node ignores tsconfig `paths` — so a static import cannot work
  in the checkout. When bundling, `scripts/package.mjs` rewrites that expression into a
  literal import of `src/pi-tools-entry.ts`, a seam whose tsconfig alias points at the
  installed package. esbuild can follow a literal, so Pi's ~265KB of tool source gets
  inlined and the artifact no longer needs its 143MB `node_modules`. Descriptions and
  schemas still come from the installed version, so they cannot drift.
- **Nothing but one wasm file is left in `node_modules`, and that is deliberate.** esbuild
  inlines every static import — Pi's tools, the MCP SDK, and express, which `--oauth` brings
  in with the SDK's authorization router — so the SDK's 5.6MB copy beside the bundle is gone;
  a packaged build with that directory deleted still served initialize, read, bash,
  human_say and a whole OAuth flow. What remains is `@silvia-odwyer/photon-node`, the 2.2MB
  wasm Pi only `import()`s when an image actually needs resizing, because a bundled wasm blob
  cannot be lazily loaded. It is copied to the *name* the bundle asks for rather than the
  nested path npm installed it at: Node resolves a bare specifier starting from
  `app/index.mjs`, and the nested location is not on that path — which is how it was found.
- **cloudflared is vendored, so a tunnel needs nothing installed.** It is copied from a
  local install when there is one (including from inside WSL when cross-building for
  Linux), and downloaded from the GitHub release otherwise. Without it the package still
  runs, just without a public URL, and the launcher says so.
- **Quick tunnels rotate their hostname on every restart.** The URL is printed each time,
  so re-paste it. For a stable hostname, run a named tunnel or a Zero Trust hostname
  instead — the bridge only ever needs `http://127.0.0.1:<port>/mcp`.

Two packaging traps that cost real time, both found by running the artifact rather than
reading the build log:

- **The bundle is ESM, so its CJS dependencies have no `require`.** esbuild's interop shim
  throws `Dynamic require of "child_process" is not supported` the moment Pi's bash tool
  pulls in `cross-spawn`. A `createRequire` banner fixes it; `format: "cjs"` cannot be used
  because `src/index.ts` awaits the listener at top level.
- **Externals must list both spellings of a builtin.** A CJS dependency writes
  `require("child_process")`, and esbuild does not normalise it to the `node:` form before
  matching `external`, so `"node:*"` alone silently misses it.

- **No single-file `.exe`.** A Node SEA would still need a runtime and the UI assets beside
  it, and the bridge has to read `ui.html` per request. A directory with a launcher is the
  honest shape.

### What actually takes up the space

Measured on the Linux package, and the Windows one differs only in ratio:

| Part | Size | Why |
|---|---|---|
| `runtime/node` | **123 MB** | The Node binary itself. Only ~41MB is `.text`; the rest is `.data`, symbols and debug info that `strip` cannot remove. This is the floor for any Node-based artifact. |
| `bin/cloudflared` | 27–39 MB | A statically linked Go binary, vendored so a tunnel needs nothing installed. |
| `app/` | 6 MB | `index.mjs` (~3.1MB: Pi's tools, plus express and the MCP SDK's authorization router for `--oauth`), Pi's lazily-loaded wasm, the UI page and its vendored libs. |

`npm`, `npx`, `corepack`, `share/` and `lib/node_modules` are deleted from the runtime: the
bridge spawns `node` on its own bundle and never runs a package manager. Deleting `bin/`
alone is not enough — that only removes the launchers, while the 17MB of npm itself lives in
`lib/node_modules`.

## Tests

```bash
npm test        # config defaults, stdio round-trip, HTTP round-trip + approval gate,
                # the OAuth flow end to end, and both UI probes
npm run typecheck
npm run accept  # end-to-end human acceptance; you reply in the browser
```

The probes spawn the real server and assert on real MCP traffic, including that a sandbox
escape is refused, that an unapproved shell command never runs, and that an authorization
code cannot be replayed, a wrong PKCE verifier is refused, and a denied request grants
nothing. `scripts/oauth-probe.mjs` then runs two more servers, because the shape of the
client decides the shape of the flow. One is a hosted product's "custom connected app" — a
pre-registered confidential client, no `--human` — driven with no PKCE at all, once with the
secret in the body and once as HTTP Basic. The other is the default, the shape plain `pimcp`
produces: credentials printed, no redirect URI known in advance, an address that arrives late
and is allowed only by the click on its card, and a public client refused outright for the
same address.

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
  leave your own machine unable to reach its own public URL — `ECONNRESET`, HTTP 000 from
  curl, or `ENOTFOUND` when the proxy also intercepts DNS — while the tunnel is perfectly
  healthy for remote clients. The reliable signal is cloudflared logging
  `Registered tunnel connection`; `pimcp` waits for exactly that and then reports the local
  probe as advisory only.
- **A model will happily end its turn on a `no_message`.** Observed with a real client agent:
  it called `human_wait` once, read `no_message`, and ended the conversation — silently dropping
  the human, which is the exact failure this bridge exists to prevent. Prompt-only instruction was
  not enough, so a `no_message` result now leads with an imperative sentence and the `<human>`
  section names the failure mode outright ("your turn must not end while you are waiting"). If you
  touch either, re-test with a real client agent — `npm test` cannot catch this.
- **Port 8765 is taken by AgentDock on this machine**, which is why the HTTP default is 8777.
- **The advertised issuer carries a trailing slash.** The SDK writes both the issuer and the
  resource metadata from `URL.href`, so a bare origin comes out as `https://host/`. That is
  fine as long as the two documents agree — a client resolves the metadata endpoint from
  `authorization_servers[0]` and compares the issuer it finds against exactly that string —
  which is what `scripts/oauth-probe.mjs` checks. Do not "fix" one of them by hand.
- **`--oauth` starts the web UI, and that is not the same as `--human`.** The UI is where
  Allow/Deny lives; the human channel is whether the agent can *talk* to you. Requiring
  `--human` for `--oauth` is what made a hosted client impossible to add: an authorization
  needs a click, not a conversation.
- **PKCE is required from a public client and optional for one with a secret.** The MCP
  specification requires S256 from every client, and the SDK's own `/token` handler enforces
  it (`code_verifier: z.string()`), which a client such as Gemini's connector may never send.
  `src/oauth-http.ts` therefore serves `/authorize` and `/token` itself, mounted *before*
  `mcpAuthRouter` so its versions are shadowed — which is why nothing in them may call
  `next()`. Discovery, `/register` and `/revoke` are still the SDK's.
- **A scope this bridge does not have is narrowed, not refused.** A hosted client asks for
  whatever its platform taught it (`openid`, `email`) and cannot learn otherwise; RFC 6749
  §3.3 allows issuing less than requested. What must never happen is granting more, and the
  probe asserts the scope on the *token*, not just on the page.
- **A redirect URI nobody registered is decided by the human, not by the bridge.** The
  credentials are printed before any address is known, and a hosted product only shows you
  its callback address afterwards — so refusing an unregistered address would make that client
  impossible, and accepting it silently would mean nobody ever looked. It is accepted and
  printed in full on the same card as Allow/Deny, and only a *confidential* client gets this:
  without a secret the exact match is all that keeps a code from being delivered elsewhere.
  Approving records the address for the rest of the run, so a repeat is not flagged again.
- **Authorization endpoints are rate-limited, and the tunnel sets `X-Forwarded-For`.**
  Express refuses to key the limiter on a header it has not been told to trust, which shows up
  as noise or a 500 that only happens behind the tunnel. `src/index.ts` sets `trust proxy 1`
  for that one hop, and the OAuth probe sends the header so this cannot regress silently.
- **Packaging used to depend on which shell started it.** Extracting the Node archive goes
  through `tar`, and Git Bash puts MSYS **GNU** tar first on `PATH` — which reads `D:\…` as a
  remote host (`Cannot execute remote shell`, then `Cannot connect to D: resolve failed`) and
  cannot read a `.zip` at all (`This does not look like a tar archive`). PowerShell worked by
  accident, because `tar` there is Windows' bsdtar. `scripts/package.mjs` now names the
  extractor (`%SystemRoot%\System32\tar.exe` on Windows) and passes `dist/`-relative paths, so
  `npm run package` behaves the same in Git Bash, PowerShell and cmd. If you see "does not look
  like a tar archive" on a zip you know is intact, that is this.

## History

This repository previously contained **HumanChat MCP**, a Python human-in-the-loop MCP
server (broker + TUI + Web UI). It was replaced by what later became `pi-as-mcp`; that code
was removed from the working tree. The old implementation, including the edits that were
uncommitted at the time of removal, is preserved at tag **`humanchat-final`**:

```bash
git show humanchat-final --stat
git checkout humanchat-final -- src/humanchat/webui_assets.py   # recover a single file
```

The project was called `pi-mcp` until it was published, and was renamed to `pi-as-mcp` to
match the repository. The command stayed `pimcp`, and the environment variables moved from
`PI_MCP_*` to `PI_AS_MCP_*` — there are no aliases for the old names.

The former `pi-mcp/` subdirectory was promoted to the repository root; `git log --follow`
crosses that move.
