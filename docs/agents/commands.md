# Commands

Run everything from the repository root. Node 22.6+ (sources are TypeScript, executed
directly via Node's type stripping — there is no build step).

```bash
npm install
npm test          # config defaults + stdio probe + HTTP/auth/approval probe + controls + the OAuth flow + both UI probes
npm run typecheck # tsc --noEmit
npm run vendor-ui # re-copy marked + KaTeX into src/human/vendor
npm run prompt    # print the ported system prompt
npm run accept    # human acceptance: drives the real server, you reply in the browser
npm run package   # build a portable dist/<platform>-<arch>/ (needs network for the Node runtime)
npm link          # once: puts `pimcp` on PATH (run from anywhere afterwards)
pimcp
pimcp --human          # ...and the human channel (off by default)
pimcp --oauth-redirect https://oauth-redirect.googleusercontent.com/r/<app>
                       # (optional) name the one address a hand-configured client may return
                       # to before it asks. Without it that address arrives with the first
                       # request and is allowed by the human's click on the card.

node src/index.ts --root <dir>                                  # stdio, tools only
node src/index.ts --root <dir> --human                          # stdio + human UI on :8790
node src/index.ts --root <dir> --http --port 8777 --token <tok> # for a remote client
node src/index.ts --root <dir> --http --oauth --issuer https://host
```

`--oauth` needs `--http`, and it starts the web UI — not the human channel. The UI is where
an authorization is approved; `--human` is whether the agent can also *talk* to you. All
environment variables use the `PI_AS_MCP_` prefix.

`~/.pimcp/config.json` (moved with `PI_AS_MCP_CONFIG`) unifies what a run is steered by:
`human`, `approval: { mode: "always" | "never" }`, `mcps` (upstream MCP servers) and `tunnel`
(quick or named, your own hostname). An explicit flag beats the file; the file beats the
defaults. Its hot layer — the human channel, the approval mode, the upstreams — applies to a
running bridge through the watcher; the tunnel layer is restart-only and says so when it
changes. The probes point `PI_AS_MCP_CONFIG` at a path that does not exist, so they assert
this bridge's defaults rather than the developer's daily setup.

