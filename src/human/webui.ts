import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { HumanChannel, ChannelEvent } from "./channel.ts";
import type { OAuthProvider } from "../oauth.ts";
import type { McpUpstream } from "../config-file.ts";
import type { ApprovalEvent, ApprovalGate } from "../approval.ts";

/**
 * The controls the web UI can exercise over the running bridge: move the sandbox
 * root, flip the human channel or the approval mode, and connect/disconnect
 * upstream MCP servers. They are one object so every endpoint below can be the
 * same two lines: guard, call, catch.
 */
export type WebUIControls = {
  setRoot(newRoot: string): Promise<void>;
  setHuman(on: boolean): Promise<void>;
  setApproval(mode: "always" | "never"): Promise<void>;
  mcpConnect(name: string, config?: McpUpstream): Promise<void>;
  mcpDisconnect(name: string): Promise<void>;
};

export type WebUIOptions = {
  host: string;
  port: number;
  token: string;
  /**
   * Static facts about this run for the info panel. A getter rather than a value:
   * the UI starts before the tools are loaded, and the panel should show whatever
   * is true now.
   */
  info: () => Record<string, unknown>;
  /**
   * The authorization server, when --oauth is on. This page is the only place an
   * authorization can be granted, which is the whole reason a client's browser is
   * told to wait here instead of being handed a button of its own.
   *
   * A getter, because the HTTP listener - and with it the provider - is built
   * after the UI is already listening. Nothing reads this until a request arrives.
   */
  readonly oauth?: Pick<OAuthProvider, "pending" | "decide" | "subscribe"> | null;
  /**
   * Held tool calls waiting for Allow or Deny. Always passed: the page is where
   * those answers are given, whether or not the human channel is on.
   */
  readonly approvals: Pick<ApprovalGate, "pending" | "decide" | "subscribe">;
  /**
   * Runtime controls for the sidebar. Optional only so the probes can boot a bare
   * UI; the bridge always passes them.
   */
  controls?: WebUIControls;
};

const VENDOR_DIR = path.join(import.meta.dirname, "vendor");

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

/**
 * Serve one file from src/human/vendor. The UI is deliberately offline-capable, so
 * nothing is fetched from a CDN; the libraries live in the tree instead.
 */
function vendorFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method !== "GET" || !url.pathname.startsWith("/vendor/")) return false;

  const rel = decodeURIComponent(url.pathname.slice("/vendor/".length));
  const abs = path.resolve(VENDOR_DIR, rel);
  // A path argument must never reach outside the vendor directory.
  if (abs !== VENDOR_DIR && !abs.startsWith(VENDOR_DIR + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return true;
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(abs);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return true;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  res.end(body);
  return true;
}

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  if (typeof header === "string" && header === `Bearer ${token}`) return true;
  if (url.searchParams.get("token") === token) return true;
  return false;
}

/** A single-page surface for the one human in the loop. */
export function startWebUI(channel: HumanChannel, opts: WebUIOptions) {
  const pagePath = path.join(import.meta.dirname, "ui.html");

  const loopback =
    opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1" || opts.host === "[::1]";
  /**
   * The controls change what this machine does (its sandbox root, its approval
   * gate). A UI that is reachable from off this machine with no token is
   * already a problem for the OAuth decision; for these it is a hard no: the
   * same condition oauth.ts warns about, but enforced rather than warned.
   */
  const controlsOpen = Boolean(opts.controls) && (loopback || Boolean(opts.token));

  /** One JSON body, capped like every other POST here. */
  const readJson = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(body || "{}"));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });

  /**
   * Read {id, allow} and hand it to one decide(): 200 when it was still waiting, 409
   * when it was already answered, had expired, or never existed - the card was real
   * and is now stale, which is what the page should say. A malformed body denies.
   */
  const decideFromBody = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    decide: (id: string, allow: boolean) => boolean,
  ): void => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      let id = "";
      let allow = false;
      try {
        const parsed = JSON.parse(body || "{}");
        id = typeof parsed.id === "string" ? parsed.id : "";
        allow = parsed.allow === true;
      } catch {
        /* ignore malformed bodies, and deny below */
      }
      const decided = id !== "" && decide(id, allow);
      res.writeHead(decided ? 200 : 409, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: decided, allow }));
    });
  };

  /** POST /ctl/<name>: one shape for every control - {ok:true} or {ok:false, error}. */
  const control = async (
    res: http.ServerResponse,
    fn: () => Promise<void>,
  ): Promise<void> => {
    if (!controlsOpen) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error:
            "the control endpoints are off: this UI is reachable from off this machine with no token. Bind it to loopback or set --ui-token.",
        }),
      );
      return;
    }
    try {
      await fn();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  /**
   * Control endpoints, registered once below and consulted first inside the
   * request handler. A list because every control is the same shape and the
   * main handler stays exactly as it was.
   */
  const serverControlHandlers: ((
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ) => boolean)[] = [];

  if (opts.controls) {
    const c = opts.controls;
    serverControlHandlers.push((req, res, url) => {
      if (req.method !== "POST" || !url.pathname.startsWith("/ctl/")) return false;
      const action = url.pathname.slice("/ctl/".length);
      void (async () => {
        const body = await readJson(req);
        if (action === "root") {
          await control(res, () => c.setRoot(String(body?.path ?? "")));
        } else if (action === "human") {
          await control(res, () => c.setHuman(body?.enabled === true));
        } else if (action === "approval") {
          await control(res, () => c.setApproval(body?.mode === "always" ? "always" : "never"));
        } else if (action === "mcp-connect") {
          await control(res, () =>
            c.mcpConnect(String(body?.name ?? ""), body?.config ?? undefined),
          );
        } else if (action === "mcp-disconnect") {
          await control(res, () => c.mcpDisconnect(String(body?.name ?? "")));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `unknown control: ${action}` }));
        }
      })();
      return true;
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!authorized(req, url, opts.token)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    if (vendorFile(req, res, url)) return;

    for (const handler of serverControlHandlers) {
      if (handler(req, res, url)) return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      // Read per request, not once at startup. The page is the part people
      // iterate on, and restarting the bridge - which for a remote agent means a
      // new tunnel hostname and a new token - is not a sane cost for a CSS tweak.
      // no-store, so a browser refresh really does show the current file.
      let html: string;
      try {
        html = fs.readFileSync(pagePath, "utf8");
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`could not read ${pagePath}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...channel.snapshot() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/info") {
      let info: Record<string, unknown>;
      try {
        info = opts.info();
      } catch (err) {
        info = { error: err instanceof Error ? err.message : String(err) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...info, channel: channel.snapshot() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const send = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      send({ type: "history", ...channel.snapshot(), entries: channel.history() });
      const unsubscribe = channel.subscribe((e: ChannelEvent) => send(e));
      // Pending authorizations are not part of the message timeline - they are not
      // something the agent said - so they travel on their own event. The page
      // keeps whatever it last received.
      send({ type: "authorizations", pending: opts.oauth?.pending() ?? [] });
      const unsubscribeAuth = opts.oauth
        ? opts.oauth.subscribe((e) => send(e))
        : () => {};
      // Held tool calls travel on their own event, for the same reason.
      send({ type: "approvals", pending: opts.approvals.pending() });
      const unsubscribeApprovals = opts.approvals.subscribe((e: ApprovalEvent) => send(e));
      const beat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(beat);
        unsubscribe();
        unsubscribeAuth();
        unsubscribeApprovals();
      });
      return;
    }

    /**
     * Answer an authorization request. Only reachable here: a client's browser is
     * parked on the bridge's public origin and told to wait, because a button there
     * would be one anybody who found the URL could press.
     */
    if (req.method === "POST" && url.pathname === "/oauth/decision") {
      if (!opts.oauth) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "no authorization server is running" }));
        return;
      }
      decideFromBody(req, res, (id, allow) => opts.oauth!.decide(id, allow));
      return;
    }

    /**
     * Answer a held tool call. The same shape as an authorization decision, and for
     * the same reason it is only answered here: the card is on this page.
     */
    if (req.method === "POST" && url.pathname === "/approval/decision") {
      decideFromBody(req, res, (id, allow) => opts.approvals.decide(id, allow));
      return;
    }

    if (req.method === "POST" && url.pathname === "/say") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let text = "";
        try {
          const parsed = JSON.parse(body || "{}");
          text = typeof parsed.text === "string" ? parsed.text : "";
        } catch {
          /* ignore malformed bodies */
        }
        if (!text.trim()) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "empty text" }));
          return;
        }
        channel.post(text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const suffix = opts.token ? `/?token=${opts.token}` : "/";
      const url = `http://${opts.host}:${opts.port}${suffix}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
