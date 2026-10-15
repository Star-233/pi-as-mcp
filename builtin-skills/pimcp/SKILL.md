---
name: pimcp
description: Configure this bridge itself (pi-as-mcp, the pimcp command): attach or detach MCP servers, the approval mode, the human channel, the config file, and the deny list. Use when a task involves adding an MCP server, changing approvals or settings, or when a tool you expect is missing or an upstream is reported unavailable.
---

# Configuring the pimcp bridge

You are connected to pi-as-mcp, a bridge running on the human's computer. Its settings live in one file, `~/.pimcp/config.json`, and you may read and write it. Under `never` an edit applies to the running bridge; under `always` every call is held for Allow or Deny, an edit included.

## See the current state

- Call `get_instructions`. It returns the bridge's rules, the live status of each attached upstream MCP server (connected, disconnected, or error), and the project instructions and skills in effect.
- Upstream tools are prefixed with their server's name, for example `github_list`. They pass the same approval gate and appear in the same timeline as local tools.
- A `[bridge notice]` on a result means the tool list, a project instructions file, or a skill changed since you last saw it. It is shown once.

## Changing the bridge yourself

Write `~/.pimcp/config.json` when the task needs a setting changed. The file is watched, so `human`, `approval.mode` and `mcps` apply to the running bridge; `tunnel` is read at startup and says so when it changes. Under `always` the write waits on the same Allow/Deny card as any other call, so a setting change can be refused like anything else.

What is not yours to change:

- the working directory (`--root`) and the deny list (`--deny`): they come from the command line and the environment, not from the file. The human moves the root from the web UI;
- granting an OAuth authorization: only a click on the local page grants one;
- the tunnel's live wiring: a change takes effect on the next start.

Do not start a second bridge to get around a setting.

If a task needs one of these, ask the human with `human_ask`. If the human channel is off, say so in your final answer. Name the exact change, and never ask the human to paste a secret into the chat. Tell them which field to fill in, and where.

## Adding an upstream MCP server

Add the entry to `mcps` in the config file: under `never` it connects to the running bridge straight away. Hand the entry to the human instead when the mode is `always` and they should own the edit, or when it needs a secret you do not have. Placeholders for secrets:

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

- `human`: `true` turns the chat channel on (`human_say`, `human_ask`, `human_wait`).
- `approval.mode`: `"always"` holds every tool call, `read` included, until the human clicks Allow or Deny in the web UI. `"never"` runs everything. Approval does not depend on the chat channel, and a chat reply does not approve a call. A call nobody answers is refused.
- `mcps`: upstream servers, as above.
- `tunnel`: how the public address is made. A change needs a restart.

The deny list is not a key here: it comes from `--deny` / `PI_AS_MCP_DENY`. It never refuses a call - a path argument that matches an entry is held for Allow or Deny in the web UI in **every** approval mode, `never` included. Path arguments are not confined to the root either: any path the process can reach is readable and writable, this config file included.

A flag on the command line beats the file. The file is watched, so `human`, `approval` and `mcps` apply to a running bridge without a restart. A malformed file is ignored, and the reason is reported to the human. Do not guess at a fix. Ask the human to check the file.

## When something is missing

1. Call `get_instructions` and check the upstream's status.
2. If it is disconnected or in error, report the error text to the human.
3. If the tool is not in the list, it was never attached or it was skipped. Say which.
