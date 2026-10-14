# Working conventions

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

