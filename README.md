# pi-mcp

A one-shot MCP bridge that gives a **remote** agent two things on **your** machine: Pi's coding
tools, and a channel to talk to you through tool calls.

Built for agent platforms that run the model in the cloud: you point the agent at this bridge and
it works on your computer. Talking through tool calls keeps one model and one context for the
whole session, and avoids the platform's chat round-trip.

No sessions, no persistence — it is meant to run for one sitting.

**→ Full documentation: [pi-mcp/README.md](pi-mcp/README.md)**
**→ Agent index: [AGENTS.md](AGENTS.md)**

## Quickstart

```bash
cd pi-mcp
npm install

# local client (stdio). The human UI comes up on 127.0.0.1:8790.
node src/index.ts --root /path/to/workdir

# remote client (HTTP). Point the platform at the printed URL.
node src/index.ts --root /path/to/workdir --http --port 8765 --token <random-token> --approve bash
```

Requires Node 22.6+; the sources are TypeScript and run directly, with no build step.

## What it exposes

| Tool | Source |
|---|---|
| `read` `write` `edit` `ls` `grep` `find` `bash` `powershell` | Pi (imported verbatim at runtime) |
| `human_say` `human_ask` `human_wait` | this project |
| `get_instructions` | this project |

## History

This repository previously contained **HumanChat MCP**, a Python human-in-the-loop MCP server.
It was replaced by `pi-mcp`. The old implementation, including the edits that were uncommitted
at the time of removal, is preserved at tag **`humanchat-final`**:

```bash
git show humanchat-final --stat
git checkout humanchat-final -- src/humanchat/webui_assets.py   # recover a single file
```
