# What this is

`pi-as-mcp` is a **one-shot MCP bridge**. It gives a remote agent (typically a cloud model on a
model-arena platform) two things on the local machine:

1. Pi's coding tools — `read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`, `powershell`.
2. A human channel — `human_say`, `human_ask`, `human_wait`, plus a local web page where the human approves tool calls and authorizations.

It can also be its own **OAuth 2.1 authorization server** (`--oauth`, and on by default in
`pimcp`), so a client can be given access without a token being pasted into it. Both shapes
have to work: a client that registers itself from the metadata, and a client configured by
hand — Gemini's "custom connected app", where the human pastes a client id and secret into
*the client* and it never calls `/register`. That is how it authenticates, not a third thing
it offers; the single human is still the one who approves, on the same local page.

It is **not** an agent: there is no model and no loop. It is a tool surface plus a queue with
exactly one human in it. **No sessions, no persistence** — the process is meant to live for one
sitting. Tokens and registered OAuth clients are in memory too, and die with it.

The command is `pimcp`; the package is `pi-as-mcp`. It was called `pi-mcp` until it was
published — see the invariant about the environment prefix before "fixing" a stray `PI_MCP_`.

The predecessor (HumanChat MCP, a Python broker + TUI + Web UI) was removed. It is preserved in
full, including the edits that were uncommitted at the time, at tag `humanchat-final`.

