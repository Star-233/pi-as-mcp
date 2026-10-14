#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { loadConfig, PROJECT } from "./config.ts";
import { OAuthProvider } from "./oauth.ts";
import { Sandbox } from "./sandbox.ts";
import { HumanChannel } from "./human/channel.ts";
import { startWebUI } from "./human/webui.ts";
import { loadPiTools } from "./pi-tools.ts";
import { createMcpServer } from "./server.ts";

// stdout is the stdio protocol channel: every log line must go to stderr.
const log = (...args: unknown[]) => console.error(`[${PROJECT}]`, ...args);

const cfg = loadConfig(process.argv.slice(2));
const channel = new HumanChannel();
const sandbox = new Sandbox(cfg.root, cfg.deny);

// A flag that cannot do anything is a mistake, not a no-op: each of these would
// otherwise look like it had taken effect.
if (cfg.oauth && !cfg.http) {
  log(
    "--oauth needs --http: stdio is a pipe to a local parent process, with no request " +
      "and no header to authenticate.",
  );
  process.exit(1);
}
if (cfg.oauth && !cfg.human) {
  log(
    "--oauth needs --human: an authorization is granted by a person clicking in the human UI, " +
      "and with the channel off there is nobody to ask and no page to ask them on.",
  );
  process.exit(1);
}
if (cfg.issuer && !cfg.oauth) {
  log("--issuer names the OAuth authorization server, so it only means something with --oauth.");
  process.exit(1);
}

/** The authorization server's own identity, and the base of everything it advertises. */
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

log(`sandbox root: ${cfg.root}`);
if (cfg.deny.length) log(`denied paths: ${cfg.deny.join(", ")}`);

let oauth: OAuthProvider | null = null;

/**
 * Facts for the human UI's info panel. Never includes a token value - the panel is
 * a local page, but "set" is all it needs to say, and a value could end up in a
 * screenshot or a bug report.
 */
const bridgeInfo = () => ({
  serverName: cfg.serverName,
  version: "0.1.0",
  root: cfg.root,
  tools: pi.tools.map((t) => t.name),
  approve: cfg.approve,
  deny: cfg.deny,
  blockMs: cfg.blockMs,
  human: cfg.human,
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

/** Length-safe: timingSafeEqual throws on different lengths, which would itself leak. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The human channel is off by default: no UI, no human_* tools, no approval gate.
// The bridge is then a pure tool surface, which is what a packaged deployment
// wants; --human turns the whole human story back on.
let ui: { url: string; close: () => Promise<void> } | null = null;
if (cfg.human) {
  try {
    ui = await startWebUI(channel, {
      host: cfg.uiHost,
      port: cfg.uiPort,
      token: cfg.uiToken,
      info: bridgeInfo,
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
  log(`human channel: ${ui.url}`);
} else {
  log("human channel: off (start with --human to enable)");
}

const pi = await loadPiTools(cfg.root, cfg.tools, sandbox);
if (pi.missing.length) log(`warning: unknown tools ignored: ${pi.missing.join(", ")}`);
log(
  cfg.human
    ? `tools: ${pi.tools.map((t) => t.name).join(", ")}, human_say, human_ask, human_wait`
    : `tools: ${pi.tools.map((t) => t.name).join(", ")}`,
);
if (cfg.approve.length) {
  // The approval gate needs somebody to ask. With the human channel off there is
  // nobody, and "fail closed" must not degrade into "allow everything" - so this
  // is a hard exit, not a warning.
  if (!cfg.human) {
    log(
      `--approve ${cfg.approve.join(",")} needs the human channel: there would be nobody to ` +
        "answer the approval prompt, and a gate with no answerer is not a gate. " +
        "Restart with --human, or drop --approve.",
    );
    process.exit(1);
  }
  log(`human approval required for: ${cfg.approve.join(", ")}`);
}
if (cfg.blockMs > 100000) {
  log(
    `warning: --block-ms ${cfg.blockMs} exceeds Cloudflare's ~100s origin timeout. ` +
      "Requests may die with a 524 before the human answers.",
  );
}

const makeServer = () => createMcpServer(cfg, pi.tools, channel);

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
    oauth = new OAuthProvider({ uiUrl: ui?.url ?? `http://${cfg.uiHost}:${cfg.uiPort}/` });
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
  channel.shutdown();
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
