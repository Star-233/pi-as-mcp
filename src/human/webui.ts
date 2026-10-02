import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { HumanChannel, ChannelEvent } from "./channel.ts";

export type WebUIOptions = { host: string; port: number; token: string };

function authorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  if (typeof header === "string" && header === `Bearer ${token}`) return true;
  if (url.searchParams.get("token") === token) return true;
  return false;
}

/** A deliberately tiny single-page surface for the one human in the loop. */
export function startWebUI(channel: HumanChannel, opts: WebUIOptions) {
  const html = fs.readFileSync(path.join(import.meta.dirname, "ui.html"), "utf8");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!authorized(req, url, opts.token)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, waiting: channel.waiting(), entries: channel.history().length }));
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
      send({ type: "history", entries: channel.history(), waiting: channel.waiting() });
      const unsubscribe = channel.subscribe((e: ChannelEvent) => send(e));
      const beat = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(beat);
        unsubscribe();
      });
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
