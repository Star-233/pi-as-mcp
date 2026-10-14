# Invariants

1. **Pi's tools are never vendored by hand.** `src/pi-tools.ts` resolves the installed package and
   deep-imports `dist/core/tools/index.js`. Do not import the package root (it drags in the TUI
   and native image codecs) and do not copy the tool files into the repository — descriptions and
   schemas must not drift from the installed version. The *packaged artifact* does inline them,
   but through `src/pi-tools-entry.ts`, whose alias still points at the installed package, so the
   artifact is built from the same bytes the checkout runs.
2. **`buildSystemPrompt` is not exported from Pi.** `src/prompt.ts` reproduces the algorithm:
   preamble raw, every other section as `<name>…</name>`, rules via Pi's own ordering
   (per-tool guidelines in tool order → global guidelines → Pi's two closing rules).
3. **Stateless HTTP needs a fresh `Server` + transport per request.** The transport keeps
   per-session state; reusing one instance makes every request after `initialize` fail with 500.
4. **A sandbox rejection is a tool error, not a protocol error.** Path resolution must stay
   inside the `try` in `pi-tools.ts` so the client sees `isError`, not a JSON-RPC failure.
5. **Approval fails closed.** `--approve bash` with no human answer must deny, never run.
6. **stdout is the stdio protocol channel.** All logging goes to stderr.
7. **No sessions, no persistence.** Do not add a session id, a store, or a broker. OAuth state is
   in-memory for the same reason: no token database, no persistence across a restart.
8. **An authorization is granted only on the human UI, and only by a click.** The page at
   `/authorize` is served from whatever address the client reached — over a tunnel, the open
   internet — so it must never carry a control that grants access, and it does not: it shows the
   request and waits. The decision travels through `202 POST /oauth/decision` on the local UI,
   which is loopback-bound and can carry `--ui-token`. Do not move, mirror or "also allow" that
   decision anywhere reachable by the client, and do not accept an OAuth answer through the
   human channel's text box — a typed "yes" there belongs to the *tool* approval gate, and mixing
   the two would let a message approve a shell command and an authorization at once.
9. **The OAuth AS never invents its own issuer.** It is `--issuer`, or the tunnel hostname, or
   loopback, and it must be the URL the client actually reached; the two metadata documents have
   to agree on it. `scripts/oauth-probe.mjs` asserts that agreement, because a mismatch is
   invisible locally and fatal for a remote client.
10. **The environment prefix is `PI_AS_MCP_`.** The old `PI_MCP_*` names are gone, not aliased —
    `scripts/config-test.mjs` asserts they are no longer read. Do not reintroduce them
    "for compatibility": nothing was ever released under them.
11. **PKCE is required from a public client and optional for one with a secret.** A client
    configured by hand — the whole reason `src/oauth-http.ts` exists — may send no
    `code_challenge` and no `code_verifier`; its secret plus an exactly-matched redirect URI
    is what protects the code. A client *without* a secret must use S256, and
    `scripts/oauth-probe.mjs` asserts both halves. Do not "simplify" this into one rule in
    either direction: requiring PKCE locks out hosted clients, and dropping the requirement
    for public clients removes the only thing protecting their codes.
12. **`src/oauth-http.ts` shadows the SDK's `/authorize` and `/token`, so nothing in it may
    call `next()`.** It is mounted first on purpose, and a `next()` would fall through to the
    SDK handler with half-parsed state.
13. **An unregistered redirect URI is decided by the human, and only for a client that has a
    secret.** The credentials are printed before any address is known — that is the point,
    since a hosted product shows you its callback address only afterwards — so refusing one
    makes such a client impossible and accepting it silently means nobody ever looked. It is
    accepted *and printed on the card*, and `OAuthProvider.decide()` records it only when the
    human allows it. Never extend this to a public client: with no secret, the exact match is
    the only thing keeping its code from being delivered elsewhere. Both halves are asserted in
    `scripts/oauth-probe.mjs`.
14. **The client credentials are minted and printed unconditionally when `--oauth` is on.**
    No flag asks for them, and the pair is not the *registration* of anything: it exists to be
    pasted into a client, and it is the only copy there is. `oauth-probe.mjs` asserts the two
    log lines, and `scripts/config-test.mjs` asserts that pinning the pair without
    `--oauth-redirect` is a complete configuration — that shape is what the launcher always
    produces.


15. **A `skill://` address is read-only, and it opens only a file inside a discovered skill directory.** `resolveSkillPath` is the only way to open one. It does not use the sandbox root, because a skill can live outside the root, so the containment that matters is the skill's own directory, checked as written and after symlinks are resolved. Every tool except `read` refuses the address. `scripts/skill-probe.mjs` covers the escapes.
