#!/usr/bin/env node
/**
 * pimcp — launcher for a *packaged* pi-mcp (dist/<platform>-<arch>/).
 *
 * This is the entry point the packaged launchers (pimcp.cmd / pimcp.sh) run. It
 * differs from bin/pimcp.mjs, which is for the development checkout:
 *
 *  - The server is the bundled `app/index.mjs`, spawned with the bundled runtime,
 *    so the machine needs no Node.
 *  - cloudflared is vendored at `bin/cloudflared[.exe]`, so the machine needs no
 *    cloudflared either. If the file is missing the tunnel is simply unavailable
 *    and the bridge still runs on localhost.
 *  - No `supervise.mjs`: this process *is* the supervisor, and it reaps both
 *    children on SIGINT/SIGTERM and on exit.
 *
 *   ./pimcp.sh                    # tunnel + human channel
 *   ./pimcp.sh --no-tunnel        # localhost only
 *   ./pimcp.sh --human --approve bash
 *
 * Everything else (--root, --port, --token, --tools, …) behaves exactly as the
 * unpackaged bridge does.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// This file ships at the package root: dist/<platform>-<arch>/pimcp.mjs. Everything
// it needs (app/, runtime/, bin/) is a sibling, so HOME is this file's directory.
const HOME = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HOME, "app", "index.mjs");

const HELP = `
pimcp — start this packaged pi-mcp bridge for the current directory.

USAGE
  pimcp [options]

The current working directory becomes the sandbox root: the agent can read and
write there and nowhere else.

OPTIONS
  --no-tunnel          Do not open a Cloudflare tunnel (localhost only).
  --root <dir>         Override the sandbox root (default: current directory).
  --token <token>      Use this bearer token instead of a generated one.
  --port <n>           MCP HTTP port (default: 8777, or a free one if taken).
  --ui-port <n>        Human web UI port (default: 8790, or a free one if taken).
  --no-open            Do not open the browser automatically.
  -h, --help           Show this help.

Passed through to the bridge:
  --human              Expose the human channel: human_say/ask/wait, the web UI
                       and the approval gate. Off by default.
  --approve <tools>    Require human approval before these tools run, e.g. bash.
                       Needs --human.
  --tools <list>       Expose only this comma-separated subset.
  --deny <paths>       Extra paths to refuse even inside the root.
  --block-ms <n>       Max time human_ask/human_wait block (default 90000).
`;

const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--approve", "--deny", "--tools", "--block-ms", "--host", "--ui-host", "--ui-token",
]);
const PASSTHROUGH_BOOL_FLAGS = new Set(["--human"]);

function parseArgs(argv) {
  const opts = {
    tunnel: true, open: true, human: false,
    root: process.cwd(), token: null, port: 8777, uiPort: 8790,
    passthrough: [], help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--no-tunnel") opts.tunnel = false;
    else if (arg === "--tunnel") opts.tunnel = true;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--open") opts.open = true;
    else if (arg === "--no-human") opts.human = false;
    else if (arg === "--root") opts.root = path.resolve(next());
    else if (arg === "--token") opts.token = next();
    else if (arg === "--port") opts.port = Number(next());
    else if (arg === "--ui-port") opts.uiPort = Number(next());
    else if (PASSTHROUGH_VALUE_FLAGS.has(arg)) opts.passthrough.push(arg, next());
    else if (PASSTHROUGH_BOOL_FLAGS.has(arg)) {
      opts.passthrough.push(arg);
      opts.human = true;
    } else if (arg.startsWith("--")) opts.passthrough.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
async function pickPort(preferred) {
  if (await portIsFree(preferred)) return preferred;
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** The vendored cloudflared, or null when the package was built without one. */
function cloudflaredPath() {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const p = path.join(HOME, "bin", exe);
  return fs.existsSync(p) ? p : null;
}

/**
 * Start the bundled server. Unlike the checkout launcher there is no
 * supervise.mjs in a package: this process watches the child itself.
 */
function startServer({ root, port, uiPort, token, passthrough }) {
  const child = spawn(process.execPath, [
    SERVER,
    "--root", root,
    "--http", "--port", String(port),
    "--ui-port", String(uiPort),
    "--token", token,
    ...passthrough,
  ], { stdio: ["ignore", "pipe", "pipe"], cwd: root });

  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const check = () => { if (buf.includes("[pi-mcp] ready")) resolve(); };
    child.stdout.on("data", (d) => { buf += d.toString(); process.stdout.write(d); check(); });
    child.stderr.on("data", (d) => { buf += d.toString(); process.stderr.write(d); check(); });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the bridge exited early (code ${code})`)));
    // Generous: importing Pi's tool graph is slow on some filesystems.
    setTimeout(() => reject(new Error("timed out waiting for the bridge to become ready")), 120000);
  });
  return { child, ready };
}

/**
 * A quick tunnel with the vendored binary. The hostname appears in cloudflared's
 * output *before* the edge connection is up, so the URL alone proves nothing —
 * `Registered tunnel connection` is the real signal.
 */
function startTunnel(port, exe) {
  const child = spawn(exe, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] });

  let log = "";
  let settleUrl = null;
  let settleRegistered = null;
  const url = new Promise((r) => (settleUrl = r));
  const registered = new Promise((r) => (settleRegistered = r));
  const finishUrl = (v) => { if (settleUrl) { settleUrl(v); settleUrl = null; } };
  const finishReg = (v) => { if (settleRegistered) { settleRegistered(v); settleRegistered = null; } };

  const onData = (d) => {
    log += d.toString();
    if (settleUrl) {
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) finishUrl(m[0]);
    }
    if (settleRegistered && /Registered tunnel connection/i.test(log)) finishReg(true);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    const msg = e.code === "ENOENT" ? `cannot run ${exe}` : e.message;
    process.stderr.write(`  ${msg}\n`);
    finishUrl(null);
    finishReg(false);
  });
  child.on("exit", (code) => {
    finishUrl(null);
    finishReg(false);
    if (code !== 0) process.stderr.write(`  cloudflared exited (code ${code})\n`);
  });
  setTimeout(() => finishUrl(null), 60000);
  setTimeout(() => finishReg(false), 90000);
  return { child, url, registered, log: () => log };
}

/** Advisory. A local proxy can make your own machine unable to reach its own URL. */
async function probeOnce(mcpUrl) {
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pimcp", version: "1" } },
      }),
      signal: AbortSignal.timeout(6000),
    });
    return { status: res.status };
  } catch (e) {
    const cause = e && e.cause ? e.cause.code ?? e.cause.message : e.message;
    return { error: cause };
  }
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch { /* not fatal */ }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

const rule = (label) => `\n${"─".repeat(72)}\n  ${label}\n${"─".repeat(72)}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!fs.existsSync(SERVER)) {
    process.stderr.write(`pimcp: this package is incomplete — ${SERVER} is missing.\n`);
    process.exit(1);
  }

  const token = opts.token ?? randomBytes(16).toString("hex");
  const port = await pickPort(opts.port);
  const uiPort = await pickPort(opts.uiPort);
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  const localMcp = `http://127.0.0.1:${port}/mcp`;

  let tunnel = null;
  let server = null;
  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\n  stopping…\n");
    killTree(tunnel && tunnel.child);
    killTree(server && server.child);
    setTimeout(() => process.exit(code ?? 0), 700).unref();
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  try {
    process.stdout.write(`\n  starting pi-mcp for ${opts.root}\n`);
    server = startServer({ root: opts.root, port, uiPort, token, passthrough: opts.passthrough });
    await server.ready;

    let publicMcp = null;
    let probeNote = null;
    if (opts.tunnel) {
      const exe = cloudflaredPath();
      if (!exe) {
        process.stderr.write("  no bundled cloudflared — running on localhost only.\n");
        process.stderr.write("  (this package was built without one; rebuild with --with-cloudflared)\n");
      } else {
        process.stdout.write("  opening a Cloudflare tunnel…\n");
        tunnel = startTunnel(port, exe);
        const base = await tunnel.url;
        if (!base) {
          process.stderr.write("  could not get a tunnel URL — falling back to localhost only.\n");
          process.stderr.write(tunnel.log().split("\n").slice(-10).map((l) => `    ${l}\n`).join(""));
        } else {
          process.stdout.write(`  tunnel url ${base} — waiting for the edge connection…\n`);
          if (await tunnel.registered) {
            publicMcp = `${base}/mcp`;
            const probe = await probeOnce(publicMcp);
            probeNote = probe.status
              ? `verified reachable from this machine (HTTP ${probe.status})`
              : `this machine could not reach its own public URL (${probe.error}). That is common behind a local VPN/proxy and does not affect a remote client.`;
          } else {
            process.stderr.write("  cloudflared never registered with Cloudflare — falling back to localhost only.\n");
            process.stderr.write(tunnel.log().split("\n").slice(-10).map((l) => `    ${l}\n`).join(""));
          }
        }
      }
    }

    const mcpUrl = publicMcp ?? localMcp;
    const scope = publicMcp
      ? "REACHABLE FROM THE INTERNET"
      : opts.tunnel ? "LOCALHOST ONLY — the tunnel did not come up" : "LOCALHOST ONLY";

    const humanBlock = opts.human
      ? `\n  Human channel — open this, it is where the agent talks to you:\n      ${uiUrl}\n`
      : `\n  Human channel: off. Restart with --human for human_say/ask/wait and the web UI.\n`;

    process.stdout.write(rule(`pi-mcp is ready — ${scope}`));
    process.stdout.write(`
  MCP URL to paste into the client:
      ${mcpUrl}

  Authorization header:
      Bearer ${token}
${humanBlock}
  The agent can read and write under:
      ${opts.root}
`);
    if (probeNote) process.stdout.write(`  tunnel: ${probeNote}\n`);
    process.stdout.write(rule("Ctrl-C stops the bridge and the tunnel"));
    process.stdout.write("\n");

    if (opts.open && opts.human) openBrowser(uiUrl);
  } catch (e) {
    process.stderr.write(`\n  ${e.message}\n`);
    shutdown(1);
    return;
  }

  await new Promise(() => {});
}

main().catch((e) => {
  process.stderr.write(`pimcp: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
