---
name: pimcp
description: Configure this bridge itself (pi-as-mcp, the pimcp command): attach or detach MCP servers, the approval mode, the human channel, the config file, and what only the human can change. Use when a task involves adding an MCP server, changing approvals or settings, or when a tool you expect is missing or an upstream is reported unavailable.
---

# Configuring the pimcp bridge

You are connected to pi-as-mcp, a bridge running on the human's computer. Its settings live in one file, `~/.pimcp/config.json`. The human controls most of them. You can read the current state and propose changes.

## See the current state

- Call `get_instructions`. It returns the bridge's rules, the live status of each attached upstream MCP server (connected, disconnected, or error), and the project instructions and skills in effect.
- Upstream tools are prefixed with their server's name, for example `github_list`. They pass the same approval gate and appear in the same timeline as local tools.
- A `[bridge notice]` on a result means the tool list, a project instructions file, or a skill changed since you last saw it. It is shown once.

## What only the human can change

Do not try to change these yourself, by any route:

- the sandbox root (`--root`), which only the web UI can move;
- the approval mode (`approval.mode`);
- upstream MCP servers: attaching, detaching, or enabling one;
- the human channel (`human`), the tunnel, and OAuth clients. Only the human can grant an authorization, by a click on the local page.

Do not write `~/.pimcp/config.json`, even if the sandbox lets you reach it. It is the human's file. Do not start a second bridge to get around a setting.

If a task needs one of these, ask the human with `human_ask`. If the human channel is off, say so in your final answer. Name the exact change, and never ask the human to paste a secret into the chat. Tell them which field to fill in, and where.

## Propose an upstream MCP server

Give the human the entry to add, with placeholders for secrets:

```json
"mcps": {
  "github": { "type": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "TOKEN": "<set in the file>" } },
  "remote": { "type": "http", "url": "https://host.example/mcp", "headers": { "Authorization": "Bearer <set in the file>" } }
}
```

- The key is the server's name and the prefix of its tools. Keep it short. A tool whose prefixed name would clash with a bridge tool is skipped.
- `"enabled": false` keeps an entry in the file but disconnected.

## The configuration file

`~/.pimcp/config.json` (moved by the `PI_AS_MCP_CONFIG` environment variable) has these keys:

- `human`: `true` turns the human channel on.
- `approval.mode`: `"always"` holds every tool call, `read` included, for a yes/no in the web UI. `"never"` runs everything. `"always"` needs the human channel on. The bridge refuses to start in that combination, and it refuses a call that would need an approval nobody can give.
- `mcps`: upstream servers, as above.
- `tunnel`: how the public address is made. A change needs a restart.

A flag on the command line beats the file. The file is watched, so `human`, `approval` and `mcps` apply to a running bridge without a restart. A malformed file is ignored, and the reason is reported to the human. Do not guess at a fix. Ask the human to check the file.

## When something is missing

1. Call `get_instructions` and check the upstream's status.
2. If it is disconnected or in error, report the error text to the human.
3. If the tool is not in the list, it was never attached or it was skipped. Say which.
