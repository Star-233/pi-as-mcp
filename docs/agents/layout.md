# Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point. Config, human UI, HTTP (an express app) or stdio transport, the bearer check, the OAuth router. |
| `src/pi-tools.ts` | Imports Pi's tool definitions and adapts them to MCP. |
| `src/prompt.ts` | Reproduces Pi's system-prompt algorithm, plus the `<human>` and skills sections. |
| `src/server.ts` | MCP server: tool list, human tools, approval gate (one setting for every tool), upstream tool forwarding. |
| `src/skills.ts` | Skill discovery (`~/.agents/skills`, and the project's `.agents/skills`, `.claude/skills` and `.pi/skills` from the git root down) and the `skill://` address. Read-only. A path is confined to its skill directory, after symlinks are resolved. |
| `src/sandbox.ts` | Path containment + deny list. The root is movable at runtime (`setRoot`), by the human through the web UI only. |
| `src/config-file.ts` | The unified config file `~/.pimcp/config.json`: read (a broken file is ignored, never fatal), atomic write-back, and a debounced directory watcher. `PI_AS_MCP_CONFIG` moves it. |
| `src/attach-mcp.ts` | Attaches other MCP servers as upstreams and re-exposes their tools with the upstream's name as a prefix. One upstream down isolates itself; a prefixed name that would shadow a bridge tool is skipped. |
| `src/oauth.ts` | The OAuth 2.1 authorization server's storage and its one human decision: clients, consent requests, codes, tokens. |
| `src/oauth-http.ts` | `/authorize` and `/token`, written here instead of taken from the SDK router: PKCE required only from a public client, the secret accepted in the body or as HTTP Basic, and a redirect URI the client was never configured with accepted for a confidential client (the human's click decides it). Mounted before `mcpAuthRouter`, so it shadows those two paths in it. |
| `src/human/channel.ts` | In-memory single-human channel (the whole "session" story). Chat *and* tool-call entries share one ordered list. |
| `src/human/webui.ts`, `ui.html` | The web UI (SSE + POST): timeline, runtime info panel, wait countdown, alerts, the **Allow/Deny cards** that are the only way to grant an authorization — and, when `--human` is off, the same page as an approval console with no composer. The sidebar's `/ctl/*` endpoints steer the running bridge (root, human channel, approval mode, upstream MCPs); they are refused outright while the UI is reachable off this machine with no token. |
| `src/human/vendor/` | marked + KaTeX, copied from `node_modules` by `npm run vendor-ui`. Committed; the UI must work with no network. |
|`scripts/*.mjs`|Probes that drive the real server over real MCP traffic.|
|`scripts/package.mjs`|Builds `dist/<platform>-<arch>/`: bundled JS (Pi's tools inlined) + the UI assets + a Node runtime + cloudflared, so the recipient needs nothing installed.|
|`src/pi-tools-entry.ts`|The bundler seam for Pi's tool modules: a literal import the tsconfig alias can resolve, so esbuild inlines them into the artifact.|
|`bin/pimcp.mjs`|The `pimcp` launcher for a checkout: ports, token, tunnel (cloudflared on PATH), ready check, browser. Opens the tunnel *before* the server when `--oauth` needs its hostname.|
|`bin/pimcp-packaged.mjs`|The launcher that ships *inside* `dist/`: bundled server + vendored cloudflared, no supervise.mjs, supervises its own child.|
| `scripts/channel-probe.mjs` | The queue semantics of the human channel: draining, ordering, stamps, the cap, the retraction case. |
| `scripts/http-probe.mjs` | The HTTP surface and the approval gate over real traffic. |
| `scripts/oauth-probe.mjs` | The whole authorization flow, including the negatives: a replayed code, a wrong PKCE verifier, a denial, a forged decision, an untrusted client name. Runs three servers, because the shape of the client decides the shape of the flow: the spec-shaped one, a hosted "custom connected app" with no PKCE, and the default one where the redirect URI arrives late. |
| `scripts/ui-probe.mjs` | Drives the UI's HTTP surface: page, vendored assets, `/info`, `/health`, the SSE stream. Asserts; exits non-zero. |
| `scripts/ui-render-probe.mjs` | Runs the page's own inline script in jsdom against the vendored libs and asserts what it renders, authorization cards included. |
| `scripts/controls-probe.mjs` | The unified config file, the movable sandbox root, the upstream aggregator, and the web UI's `/ctl` endpoints over real traffic — plus the hot-reload watcher. |
| `scripts/fixtures/mini-mcp-server.mjs` | The smallest possible MCP server (two tools over stdio), so the aggregator can be tested against a real upstream with no network. |
| `bin/supervise.mjs` | Parent-death watchdog so children cannot outlive the launcher. |

