#!/usr/bin/env node
import http from "node:http";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { HumanChannel } from "./human/channel.ts";
import { startWebUI } from "./human/webui.ts";
import { loadPiTools } from "./pi-tools.ts";
import { createMcpServer } from "./server.ts";

// stdout is the stdio protocol channel: every log line must go to stderr.
const log = (...args: unknown[]) => console.error("[pi-mcp]", ...args);

const cfg = loadConfig(process.argv.slice(2));
const channel = new HumanChannel();
const sandbox = new Sandbox(cfg.root, cfg.deny);

log(`sandbox root: ${cfg.root}`);
if (cfg.deny.length) log(`denied paths: ${cfg.deny.join(", ")}`);

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
  pid: process.pid,
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
});

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
  if (!cfg.httpToken) {
    log("warning: --http without --token: anyone who can reach this port gets a shell. Set --token.");
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (cfg.httpToken) {
        const header = req.headers["authorization"];
        const ok =
          (typeof header === "string" && header === `Bearer ${cfg.httpToken}`) ||
          url.searchParams.get("token") === cfg.httpToken;
        if (!ok) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }

      // Stateless HTTP: a fresh Server + transport per request. The transport
      // keeps per-session state (initialization, streams), so reusing one
      // instance across requests makes the second request fail.
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
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  });

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
