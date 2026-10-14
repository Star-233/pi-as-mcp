# AGENTS.md

Index for agents working in this repository. The full manual is [README.md](README.md); read it before making non-trivial changes.

This file is an index only. It stays under 1000 tokens. Put rules and procedures in the matching file under `docs/agents/`.

## What this is

`pi-as-mcp` (command `pimcp`) is a one-shot MCP bridge. It serves Pi's coding tools and a local human-approval channel to one remote agent, optionally behind its own OAuth 2.1 server. There is no model, no session, and no persistence. Details: [overview](docs/agents/overview.md).

## Where to look

- [Layout](docs/agents/layout.md): the source tree and what each module owns.
- [Commands](docs/agents/commands.md): typecheck, tests, probes, packaging.
- [Invariants](docs/agents/invariants.md): rules that must not regress. Read before touching auth, the sandbox, approval, or the human channel.
- [Working conventions](docs/agents/conventions.md): how changes are made here.
- [Gotchas](docs/agents/gotchas.md): past failures and their causes. Search it before debugging.
- [Open questions](docs/agents/open-questions.md): decisions not yet made. Ask the user before deciding them.
