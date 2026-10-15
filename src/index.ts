#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolChangeTracker } from "./tool-watch.ts";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { loadConfig, PROJECT } from "./config.ts";
import {
  readFileConfig,
  watchFileConfig,
  writeFileConfig,
  type BridgeConfigFile,
  type McpUpstream,
} from "./config-file.ts";
import { McpAggregator } from "./attach-mcp.ts";
import { OAuthProvider, sameSecret } from "./oauth.ts";
import { mountOAuthEndpoints } from "./oauth-http.ts";
import { Sandbox } from "./sandbox.ts";
import { HumanChannel } from "./human/channel.ts";
import { startWebUI } from "./human/webui.ts";
import { loadPiTools } from "./pi-tools.ts";
import { createMcpServer, type RuntimeState } from "./server.ts";

// stdout is the stdio protocol channel: every log line must go to stderr.
const log = (...args: unknown[]) => console.error(`[${PROJECT}]`, ...args);

const cfg = loadConfig(process.argv.slice(2));
if (cfg.configFileError) {
  log(`warning: ${cfg.configFileError} - the file was ignored`);
} else if (Object.keys(cfg.mcps).length) {
  log(`config file: ${cfg.configPath}`);
}
const channel = new HumanChannel();
const sandbox = new Sandbox(cfg.root, cfg.deny);

/**
 * The mutable half of the configuration: what the config file and the web UI can
 * change while the bridge runs. Everything else in `cfg` is fixed for this run.
 */
const state: RuntimeState = { human: cfg.human, approvalMode: cfg.approvalMode };

/** Created once Pi's tools are loaded (their names are the reserved set). */
let aggregator: McpAggregator | null = null;

// A flag that cannot do anything is a mistake, not a no-op: each of these would
// otherwise look like it had taken effect.
if (cfg.oauth && !cfg.http) {
  log(
    "--oauth needs --http: stdio is a pipe to a local parent process, with no request " +
      "and no header to authenticate.",
  );
  process.exit(1);
}
if (cfg.issuer && !cfg.oauth) {
  log("--issuer names the OAuth authorization server, so it only means something with --oauth.");
  process.exit(1);
}
if (cfg.oauthRedirects.length && !cfg.oauth) {
  log("--oauth-redirect describes a client of the authorization server, so it needs --oauth.");
  process.exit(1);
}
if (Boolean(cfg.oauthClientId) !== Boolean(cfg.oauthClientSecret)) {
  log(
    "--oauth-client-id and --oauth-client-secret have to be given together: pinning one and " +
      "minting the other would break the pair a client has already been configured with.",
  );
  process.exit(1);
}
for (const uri of cfg.oauthRedirects) {
  try {
    new URL(uri);
  } catch {
    log(`--oauth-redirect is not a URL: ${uri}`);
    process.exit(1);
  }
}

/**
 * The authorization server's own identity, and the base of everything it advertises.
 */
let issuer: URL | null = null;
/** The URL clients actually call. Also the audience stamped into tokens. */
let resource: URL | null = null;
if (cfg.oauth) {
  try {
    issuer = new URL(cfg.issuer || `http://127.0.0.1:${cfg.httpPort}`);
  } catch {
    log(`--issuer is not a URL: ${cfg.issuer}`);
    process.exit(1);
  }
  resource = new URL("/mcp", issuer);
}

/**
 * A client that is configured by hand instead of registering itself. Its
 * credentials have to come from somewhere, and the only somewhere is here, so
 * they are minted unless the caller pinned them - pinning is what makes a restart
 * survivable, since a client that already holds the old pair cannot be told.
 *
 * It exists whenever the authorization server does, not only when a redirect URI
 * was given, because the pair is what a person needs in hand before they can
 * configure anything: the client shows them the callback address it wants, and
 * there is no way to know it in advance. With no addresses listed, the human's
 * first approval is what establishes one (`learnRedirects`).
 */
const staticClient = cfg.oauth
  ? {
      clientId: cfg.oauthClientId || `pimcp-${crypto.randomBytes(9).toString("base64url")}`,
      clientSecret: cfg.oauthClientSecret || crypto.randomBytes(32).toString("base64url"),
      redirectUris: cfg.oauthRedirects,
      learnRedirects: cfg.oauthRedirects.length === 0,
    }
  : null;

log(`sandbox root: ${cfg.root}`);
if (cfg.deny.length) log(`denied paths: ${cfg.deny.join(", ")}`);

let oauth: OAuthProvider | null = null;

/**
 * Facts for the human UI's info panel. Never includes a token value - the panel is
 * a local page, but "set" is all it needs to say, and a value could end up in a
 * screenshot or a bug report.
 */
/**
 * What the web UI may do to the running bridge, from its own buttons. The UI is
 * loopback by default; when it is reachable from elsewhere these endpoints are
 * refused inside webui.ts unless a UI token is set, the same rule that governs
 * the OAuth decision.
 */
const controls = {
  async setRoot(newRoot: string): Promise<void> {
    if (typeof newRoot !== "string" || !newRoot.trim()) throw new Error("a directory path is required");
    sandbox.setRoot(newRoot); // throws SandboxError with the reason
    log(`sandbox root moved to ${sandbox.root} (from the web UI)`);
  },
  async setHuman(on: boolean): Promise<void> {
    if (on !== true && on !== false) throw new Error("enabled must be true or false");
    if (!on && state.approvalMode === "always") {
      throw new Error('approval mode is "always", which needs the human channel to answer the gate; switch approval to "never" first');
    }
    state.human = on;
    writeFileConfig((c) => {
      c.human = on;
    });
    log(`config: human channel ${on ? "on" : "off"} (from the web UI)`);
  },
  async setApproval(mode: "always" | "never"): Promise<void> {
    if (mode !== "always" && mode !== "never") throw new Error('approval mode is "always" or "never"');
    if (mode === "always" && !state.human) {
      throw new Error('approval mode "always" needs the human channel on: there would be nobody to approve the calls');
    }
    state.approvalMode = mode;
    writeFileConfig((c) => {
      c.approval = { ...(c.approval ?? {}), mode };
    });
    log(`config: approval mode ${mode} (from the web UI)`);
  },
  async mcpConnect(name: string, config?: McpUpstream): Promise<void> {
    if (!aggregator) throw new Error("still starting up; try again in a moment");
    if (typeof name !== "string" || !/^[A-Za-z0-9 _-]{1,32}$/.test(name.trim())) {
      throw new Error("the upstream needs a short name of letters, digits, spaces, - or _");
    }
    const trimmed = name.trim();
    if (config !== undefined) {
      const upstream = config as McpUpstream;
      if (upstream.type === "stdio" && !upstream.command) throw new Error("a stdio upstream needs a command");
      if (upstream.type === "http" && !upstream.url) throw new Error("an http upstream needs a url");
      if (upstream.type !== "stdio" && upstream.type !== "http") throw new Error('upstream type is "stdio" or "http"');
      // Headers (an Authorization token) are only ever written from the UI as
      // part of a url-less config edit; the UI form does not offer them, and the
      // file is the only place they can come from.
      writeFileConfig((c) => {
        c.mcps = { ...(c.mcps ?? {}), [trimmed]: { ...upstream, enabled: true } };
      });
    }
    const upstream = readFileConfig().config.mcps?.[trimmed];
    if (!upstream) throw new Error(`no upstream named "${trimmed}" in ${cfg.configPath}`);
    // A name-only connect (the UI's reconnect button on a disabled entry) has to
    // clear the enabled:false that a disconnect wrote, or the next reconcile -
    // any file change triggers one - would silently disconnect it again.
    writeFileConfig((c) => {
      if (c.mcps?.[trimmed]) c.mcps[trimmed] = { ...c.mcps[trimmed], enabled: true };
    });
    const res = await aggregator.connect(trimmed, upstream, { fromConfig: true, enabled: true });
    if (!res.ok) throw new Error(res.error ?? `could not connect to ${trimmed}`);
  },
  async mcpDisconnect(name: string): Promise<void> {
    if (!aggregator) throw new Error("still starting up; try again in a moment");
    const file = readFileConfig().config;
    if (file.mcps?.[name]) {
      // Keep it configured for next time: the entry stays in the file, switched off.
      writeFileConfig((c) => {
        if (c.mcps?.[name]) c.mcps[name] = { ...c.mcps[name], enabled: false };
      });
    }
    await aggregator.disconnect(name);
  },
};

const bridgeInfo = () => ({
  serverName: cfg.serverName,
  version: "0.1.0",
  root: sandbox.root,
  tools: pi.tools.map((t) => t.name),
  approve: state.approvalMode === "always" ? ["*"] : [],
  approvalMode: state.approvalMode,
  mcps: aggregator ? aggregator.summary() : [],
  configPath: cfg.configPath,
  deny: cfg.deny,
  blockMs: cfg.blockMs,
  human: state.human,
  // The page needs both: `humanUI` says whether there is a composer to type into,
  // `human` whether an agent is listening on the other end of it.
  humanUI: cfg.humanUI,
  transport: cfg.http ? "http" : "stdio",
  endpoint: cfg.http ? `http://${cfg.httpHost}:${cfg.httpPort}/mcp` : "stdio",
  httpTokenSet: Boolean(cfg.httpToken),
  uiTokenSet: Boolean(cfg.uiToken),
  // Always present, so the panel has one shape to render rather than two.
  oauth: oauth && issuer
    ? {
        enabled: true,
        issuer: issuer.href,
        grants: oauth.stats(),
        // Approval happens on the UI, so a UI reachable off this machine - or one
        // with no token - is a way for somebody else to authorize themselves.
        uiExposed: Boolean(cfg.uiToken) === false && !isLoopbackHost(cfg.uiHost),
      }
    : { enabled: false },
  pid: process.pid,
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
});

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

// The web UI is started when the human channel is on, and also when only --oauth
// is: the UI is where an authorization is approved, which is a question about
// who may click Allow, not about whether the agent can hold a conversation.
// Without either flag the bridge is a pure tool surface.
let ui: { url: string; close: () => Promise<void> } | null = null;
if (cfg.humanUI) {
  try {
    ui = await startWebUI(channel, {
      host: cfg.uiHost,
      port: cfg.uiPort,
      token: cfg.uiToken,
      info: bridgeInfo,
      controls,
      get oauth() {
        return oauth;
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    log(
      code === "EADDRINUSE"
        ? `human UI port ${cfg.uiPort} is already in use. Pick another with --ui-port.`
        : `could not start the human UI on port ${cfg.uiPort}: ${err}`,
    );
    process.exit(1);
  }
  log(
    cfg.human
      ? `human channel: ${ui.url}`
      : `approval UI: ${ui.url} (no --human, so human_say/ask/wait are off)`,
  );
} else {
  log("human channel: off (start with --human to enable, or --oauth for approvals only)");
}

const pi = await loadPiTools(cfg.root, cfg.tools, sandbox);
if (pi.missing.length) log(`warning: unknown tools ignored: ${pi.missing.join(", ")}`);

// Upstream MCP tools are prefixed with their server's name, so the only rule
// about collisions is "this bridge's own names win": a prefixed name that
// matches one of them is skipped at connect time (see attach-mcp.ts).
const reserved = new Set<string>([
  ...pi.tools.map((t) => t.name),
  "human_say",
  "human_ask",
  "human_wait",
  "get_instructions",
]);
aggregator = new McpAggregator({
  reserved: (name) => reserved.has(name),
  log,
});
{
  const enabled = Object.entries(cfg.mcps).filter(([, u]) => u.enabled !== false);
  if (enabled.length) {
    log(`mcp upstreams (config file): ${enabled.map(([n]) => n).join(", ")}`);
    // Not awaited: a slow or dead upstream must not delay "ready". A failure is
    // logged and shows up in the UI as an error with a retry button.
    for (const [name, upstream] of enabled) {
      void aggregator.connect(name, upstream, { fromConfig: true, enabled: true });
    }
  }
}
log(
  cfg.human
    ? `tools: ${pi.tools.map((t) => t.name).join(", ")}, human_say, human_ask, human_wait`
    : `tools: ${pi.tools.map((t) => t.name).join(", ")}`,
);
if (cfg.approvalMode === "always") {
  // The approval gate needs somebody to ask. With the human channel off there is
  // nobody, and "fail closed" must not degrade into "allow everything" - so this
  // is a hard exit, not a warning. ("always" comes from --approve or the config
  // file; the per-tool list a --approve used to take is now just this mode.)
  if (!cfg.human) {
    log(
      'approval mode "always" needs the human channel: there would be nobody to answer the gate. ' +
        "Restart with --human, or set human: true in the config file.",
    );
    process.exit(1);
  }
  log("approval: every tool call waits for a yes/no from the human");
}
if (cfg.blockMs > 100000) {
  log(
    `warning: --block-ms ${cfg.blockMs} exceeds Cloudflare's ~100s origin timeout. ` +
      "Requests may die with a 524 before the human answers.",
  );
}

// One tracker for the whole process: what the agent was last shown is process-wide.
const toolTracker = new ToolChangeTracker();
const makeServer = () => createMcpServer(cfg, pi.tools, channel, { state, sandbox, aggregator, tracker: toolTracker });

/** Two upstream configs are the same if they differ at most in the enabled flag. */
function sameUpstream(a: McpUpstream | undefined, b: McpUpstream): boolean {
  if (!a) return false;
  const stable = (u: McpUpstream) =>
    JSON.stringify(
      Object.entries(u)
        .filter(([k]) => k !== "enabled")
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  return stable(a) === stable(b);
}

/**
 * Bring the upstream set in line with the config file: connect what appeared or
 * was switched on, disconnect what disappeared or was switched off. Idempotent
 * by construction (connect is a no-op on a connected upstream), so the watcher
 * and a UI action that both save the same file converge on the same state.
 */
async function reconcileMcps(file: BridgeConfigFile): Promise<void> {
  if (!aggregator) return;
  const desired = file.mcps ?? {};
  for (const [name, upstream] of Object.entries(desired)) {
    const current = aggregator.summary().find((u) => u.name === name);
    const connected = current?.status === "connected" || current?.status === "connecting";
    // A connected upstream whose config changed (command, URL, headers...) is reconnected,
    // so the file's version is the one that runs. Connect alone would be a no-op here.
    const changed = connected && !sameUpstream(aggregator.configOf(name), upstream);
    if (upstream.enabled === false && connected) {
      await aggregator.disconnect(name);
    } else if (upstream.enabled !== false && changed) {
      await aggregator.disconnect(name);
      await aggregator.connect(name, upstream, { fromConfig: true, enabled: true });
    } else if (upstream.enabled !== false && !connected) {
      await aggregator.connect(name, upstream, { fromConfig: true, enabled: true });
    }
  }
  for (const u of aggregator.summary()) {
    if (u.fromConfig && !(u.name in desired)) {
      await aggregator.disconnect(u.name);
    }
  }
}

// Hot-reload: the file's hot layer applies live (human channel, approval mode,
// upstreams); the restart layer is only reported, because a tunnel cannot be
// rewired under a running process. prev === null is the initial read, not a change.
const unwatchConfig = watchFileConfig((file, prev) => {
  // The hot layer is APPLIED, not diffed. The debounce coalesces bursts of
  // UI saves into one read, so a diff against the previous read can miss a
  // field that went A -> B -> A while the in-memory state still holds B - it
  // would never converge. Setting from the file is idempotent and always
  // converges; `prev` is only for the change log and the restart-layer notice.
  if (file.human !== undefined) {
    if (!file.human && state.approvalMode === "always") {
      log('config: refusing to turn the human channel off while approval mode is "always" - the gate would have nobody to answer it.');
    } else {
      const changed = state.human !== file.human;
      state.human = file.human;
      if (changed) log(`config (hot): human channel ${state.human ? "on" : "off"}`);
    }
  }
  const mode = file.approval?.mode;
  if (mode === "always" || mode === "never") {
    if (mode === "always" && !state.human) {
      log('config: refusing approval mode "always" while the human channel is off - there would be nobody to answer. Turn the channel on first.');
    } else {
      const changed = state.approvalMode !== mode;
      state.approvalMode = mode;
      if (changed) log(`config (hot): approval mode ${mode}`);
    }
  }
  // Reconcile unconditionally: it diffs the file against the live aggregator
  // itself, so coalescing cannot desynchronize it, and it early-returns on
  // upstreams that are already up.
  void reconcileMcps(file).catch(() => {});
  if (prev && JSON.stringify(file.tunnel ?? {}) !== JSON.stringify(prev.tunnel ?? {})) {
    log("config: tunnel settings changed - they take effect on the next start; the current tunnel keeps running.");
  }
});

let closeTransport: () => Promise<void>;

if (cfg.http) {
  if (!cfg.httpToken && !cfg.oauth) {
    log("warning: --http without --token: anyone who can reach this port gets a shell. Set --token.");
  }

  const app = express();
  app.disable("x-powered-by");
  // The tunnel hop is the only proxy in front of this. Declaring exactly one keeps
  // the rate limiter keyed per client instead of lumping every request behind
  // cloudflared into one bucket - and keeps it from complaining about the
  // X-Forwarded-For header it would otherwise see and not trust.
  app.set("trust proxy", 1);

  if (cfg.oauth && issuer && resource) {
    oauth = new OAuthProvider({ uiUrl: ui?.url ?? `http://${cfg.uiHost}:${cfg.uiPort}/`, staticClient });
    // Mounted first, so these two paths win over the SDK's own. The SDK still
    // serves discovery, registration and revocation; see src/oauth-http.ts for why
    // /authorize and /token are not its.
    mountOAuthEndpoints(app, oauth, log);
    try {
      app.use(
        mcpAuthRouter({
          provider: oauth,
          issuerUrl: issuer,
          resourceServerUrl: resource,
          resourceName: `${PROJECT} - a shell and a filesystem on the machine running it`,
          scopesSupported: oauth.scopes,
        }),
      );
    } catch (err) {
      log(
        `could not start the OAuth authorization server: ${err instanceof Error ? err.message : err}. ` +
          "The issuer must be https, or a loopback http address; for a public http URL set " +
          "MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true and understand what that means.",
      );
      process.exit(1);
    }

    // The browser parked on the consent page asks here, and it has no token: the
    // page is served from whatever address the client reached. The unguessable id
    // in the query is the only key, and it reveals nothing but that one decision.
    app.get("/oauth/pending", (req, res) => {
      const id = typeof req.query.id === "string" ? req.query.id : "";
      res.set("cache-control", "no-store");
      res.json(oauth!.status(id));
    });

    log(`oauth: authorization server at ${issuer.href}`);
    log(`oauth: resource ${resource.href}, approved by hand on the human UI`);
    if (staticClient) {
      // Printed where a person can copy it: this pair exists to be pasted into the
      // client's own OAuth settings, and it is the only copy there is.
      log(`oauth: client id     ${staticClient.clientId}`);
      log(`oauth: client secret  ${staticClient.clientSecret}`);
      if (staticClient.redirectUris.length) {
        for (const uri of staticClient.redirectUris) log(`oauth: redirects to  ${uri}`);
      } else {
        log(
          "oauth: no redirect URI is set up in advance, so the first address this client asks to " +
            "be sent to is shown to you and allowed by your own approval (--oauth-redirect names " +
            "one up front instead).",
        );
      }
    }
    if (isLoopbackHost(issuer.hostname)) {
      log(
        "warning: the issuer is a loopback address, so a client off this machine cannot use it. " +
          "Restart with --issuer <the URL clients reach, e.g. https://your-host>.",
      );
    }
    if (cfg.uiToken === "" && !isLoopbackHost(cfg.uiHost)) {
      log(
        `warning: --oauth with --ui-host ${cfg.uiHost} and no --ui-token means anyone who can reach ` +
          "the human UI can approve an authorization and be handed a shell here.",
      );
    }
  }

  /** The bearer token, from the header or - as this bridge has always allowed - the query. */
  const presentedToken = (req: express.Request): string | null => {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      return header.slice(7).trim() || null;
    }
    const query = req.query.token;
    return typeof query === "string" && query ? query : null;
  };

  app.use((req, res, next) => {
    void (async () => {
      const token = presentedToken(req);
      if (token && cfg.httpToken && sameSecret(token, cfg.httpToken)) return next();
      if (token && oauth) {
        try {
          await oauth.verifyAccessToken(token);
          return next();
        } catch {
          /* not an access token this server issued: fall through to the 401 */
        }
      }
      // No token configured and no authorization server: an open bridge, exactly as
      // it behaved before --oauth existed.
      if (!cfg.httpToken && !oauth) return next();
      res.status(401);
      // Without this a client cannot find out that OAuth is even an option; the
      // header is how the whole discovery flow starts.
      if (oauth && resource) {
        res.set("www-authenticate", `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(resource)}"`);
      }
      res.json({ error: "unauthorized" });
    })();
  });

  // Everything the authorization server did not answer is an MCP request.
  //
  // Stateless HTTP: a fresh Server + transport per request. The transport keeps
  // per-session state (initialization, streams), so reusing one instance across
  // requests makes the second request fail.
  app.use((req, res) => {
    void (async () => {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        log("http request failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) {
          res.status(500).json({ error: "internal error" });
        }
      }
    })();
  });

  const httpServer = http.createServer(app);

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(cfg.httpPort, cfg.httpHost, resolve);
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EADDRINUSE") {
      log(`port ${cfg.httpPort} on ${cfg.httpHost} is already in use. Pick another with --port.`);
    } else {
      log("could not start the HTTP listener:", err);
    }
    await ui?.close();
    process.exit(1);
  }
  log(`MCP over HTTP: http://${cfg.httpHost}:${cfg.httpPort}/mcp`);
  closeTransport = async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
    httpServer.closeAllConnections?.();
  };
} else {
  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP over stdio: ready");
  closeTransport = async () => {};
}

const stop = async () => {
  log("shutting down");
  unwatchConfig();
  channel.shutdown();
  try {
    await aggregator?.closeAll();
  } catch {
    /* best effort */
  }
  try {
    await closeTransport();
  } catch {
    /* ignore */
  }
  await ui?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

log("ready");
