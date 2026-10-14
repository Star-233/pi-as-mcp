#!/usr/bin/env node
/**
 * pimcp — launcher for a *packaged* pi-as-mcp (dist/<platform>-<arch>/).
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
 *   ./pimcp.sh --human --oauth    # clients authorize themselves
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
pimcp — start this packaged pi-as-mcp bridge for the current directory.

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
  --oauth              Serve an OAuth 2.1 authorization server in front of /mcp,
                       so a client can authorize itself instead of being handed a
                       token. ON by default; --no-oauth turns it off. A client id and
                       secret are minted and printed every run, for the client you
                       configure by hand; one that registers itself needs neither.
  --no-oauth           Do not run the authorization server.
  --oauth-redirect <uri>
                       Name the ONE address a hand-configured client is allowed to
                       return to, before it ever asks. Without this the address is not
                       known in advance (nobody can know it until the client shows
                       it), so the first request from it is listed on the approval
                       card and allowed by your own click. Comma-separated for several.
  --oauth-client-id <id>
  --oauth-client-secret <secret>
                       Use this pair instead of minting one, so a restart does not
                       invalidate credentials already pasted into a client.
  --issuer <url>       The URL clients reach, e.g. https://mcp.example.com. Only
                       with --oauth. Defaults to the quick-tunnel hostname.
  --approve           Approval mode "always": every tool call waits for a yes/no in the
                       human UI. A value after the flag is accepted but ignored.
                       Needs --human.
  --tools <list>       Expose only this comma-separated subset.
  --deny <paths>       Extra paths to refuse even inside the root.
  --block-ms <n>       Max time human_ask/human_wait block (default 90000).
`;

const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--approve", "--deny", "--tools", "--block-ms", "--host", "--ui-host", "--ui-token",
  "--issuer",
]);
const PASSTHROUGH_BOOL_FLAGS = new Set(["--human", "--oauth"]);

function parseArgs(argv) {
  const opts = {
    tunnel: true, open: true, human: false,
    // On by default, like the checkout launcher: a remote client needs some way in,
    // and an authorization it grants itself beats a token pasted between two chats.
    oauth: true,
    oauthRedirects: [], clientId: null, clientSecret: null,
    root: process.cwd(), token: null, issuer: null, port: 8777, uiPort: 8790,
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
    else if (arg === "--human") opts.human = true;
    else if (arg === "--no-human") opts.human = false;
    else if (arg === "--oauth") opts.oauth = true;
    else if (arg === "--no-oauth") opts.oauth = false;
    else if (arg === "--root") opts.root = path.resolve(next());
    else if (arg === "--token") opts.token = next();
    else if (arg === "--port") opts.port = Number(next());
    else if (arg === "--ui-port") opts.uiPort = Number(next());
    else if (arg === "--issuer") opts.issuer = next();
    else if (arg === "--oauth-redirect") opts.oauthRedirects.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--oauth-client-id") opts.clientId = next();
    else if (arg === "--oauth-client-secret") opts.clientSecret = next();
    else if (PASSTHROUGH_VALUE_FLAGS.has(arg)) opts.passthrough.push(arg, next());
    else if (PASSTHROUGH_BOOL_FLAGS.has(arg)) opts.passthrough.push(arg);
    else if (arg.startsWith("--")) opts.passthrough.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  // Forward the resolved values rather than what was typed, so a later --no-human
  // cannot leave an --oauth behind that the bridge would then have to reject.
  if (opts.human) opts.passthrough.push("--human");
  if (opts.clientId || opts.clientSecret) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error(
        "--oauth-client-id and --oauth-client-secret have to be given together: pinning one and " +
          "minting the other would break the pair a client has already been configured with.",
      );
    }
  }
  // A flag that cannot do anything is a mistake, not a no-op - the same rule the
  // bridge applies. Without this the redirect URIs would simply never be forwarded.
  if (!opts.oauth && (opts.oauthRedirects.length || opts.clientId || opts.clientSecret)) {
    throw new Error(
      "--oauth-redirect/--oauth-client-id/--oauth-client-secret describe the authorization " +
        "server's client, so they need --oauth (--no-oauth turns it off).",
    );
  }
  if (opts.oauth) {
    opts.passthrough.push("--oauth");
    if (opts.oauthRedirects.length) opts.passthrough.push("--oauth-redirect", opts.oauthRedirects.join(","));
    // Always, not only when a redirect URI was named: the pair is what you paste into
    // the client *before* it can tell you which address it wants to come back to.
    opts.clientId = opts.clientId || `pimcp-${randomBytes(9).toString("base64url")}`;
    opts.clientSecret = opts.clientSecret || randomBytes(32).toString("base64url");
    opts.passthrough.push("--oauth-client-id", opts.clientId, "--oauth-client-secret", opts.clientSecret);
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
function startServer({ root, port, uiPort, token, issuer, passthrough }) {
  const args = [
    SERVER,
    "--root", root,
    "--http", "--port", String(port),
    "--ui-port", String(uiPort),
    "--token", token,
    ...passthrough,
  ];
  if (issuer) args.push("--issuer", issuer);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: root });

  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const check = () => { if (buf.includes("[pi-as-mcp] ready")) resolve(); };
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

/**
 * Start a quick tunnel and wait for its hostname. A missing hostname is reported
 * here, once, because it is the same outcome whether the tunnel was opened early
 * (for --oauth) or late.
 */
async function openTunnel(port, exe) {
  process.stdout.write("  opening a Cloudflare tunnel…\n");
  const t = startTunnel(port, exe);
  const base = await t.url;
  if (!base) {
    process.stderr.write("  could not get a tunnel URL — falling back to localhost only.\n");
    process.stderr.write(t.log().split("\n").slice(-10).map((l) => `    ${l}\n`).join(""));
  }
  return { tunnel: t, base };
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
    process.stdout.write(`\n  starting pi-as-mcp for ${opts.root}\n`);

    const cloudflared = cloudflaredPath();
    if (opts.tunnel && !cloudflared) {
      process.stderr.write("  no bundled cloudflared — running on localhost only.\n");
      process.stderr.write("  (this package was built without one; rebuild with --with-cloudflared)\n");
    }

    // With --oauth the tunnel has to be up *before* the server starts. The
    // authorization server advertises a single issuer in its metadata, and a client
    // checks that against the address it actually reached — so it has to be the
    // public hostname, which exists only once cloudflared has printed it.
    let publicBase = null;
    if (opts.tunnel && cloudflared && opts.oauth && !opts.issuer) {
      const opened = await openTunnel(port, cloudflared);
      tunnel = opened.tunnel;
      publicBase = opened.base;
    }

    const issuer = opts.oauth ? opts.issuer ?? publicBase : null;
    server = startServer({ root: opts.root, port, uiPort, token, issuer, passthrough: opts.passthrough });
    await server.ready;

    let publicMcp = null;
    let probeNote = null;
    if (opts.tunnel && cloudflared) {
      if (!tunnel) {
        const opened = await openTunnel(port, cloudflared);
        tunnel = opened.tunnel;
        publicBase = opened.base;
      }
      if (publicBase) {
        process.stdout.write(`  tunnel url ${publicBase} — waiting for the edge connection…\n`);
        if (await tunnel.registered) {
          publicMcp = `${publicBase}/mcp`;
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

    const mcpUrl = publicMcp ?? localMcp;
    const scope = publicMcp
      ? "REACHABLE FROM THE INTERNET"
      : opts.tunnel ? "LOCALHOST ONLY — the tunnel did not come up" : "LOCALHOST ONLY";

    // The UI runs when the human channel is on, and also when only --oauth is: it is
    // where an authorization is approved, and the two reasons read differently.
    const humanBlock = opts.human
      ? `\n  Human channel — open this, it is where the agent talks to you:\n      ${uiUrl}\n`
      : opts.oauth
        ? `\n  Approve access here — this page is the only place an authorization can be granted:\n      ${uiUrl}\n`
        : `\n  Human channel: off. Restart with --human for human_say/ask/wait and the web UI.\n`;
    // What the server will advertise, not what the launcher was handed: the server
    // normalizes this with `new URL(...)` (adding the root slash) and falls back to
    // loopback when no issuer is passed, so the banner mirrors both or it prints a
    // value no client ever saw.
    const advertisedIssuer = opts.oauth
      ? new URL(issuer ?? `http://127.0.0.1:${port}`).href
      : null;
    // A client that registers itself needs none of this; one configured by hand needs
    // all of it, and this is the only copy that exists, so it is printed in full - always,
    // because it is what you paste in before the client can tell you its redirect URI.
    const clientBlock = !opts.oauth
      ? ""
      : opts.oauthRedirects.length
        ? `\n  Client credentials — paste these into the client's own OAuth settings:\n      client id      ${opts.clientId}\n      client secret  ${opts.clientSecret}\n  It may only return to the address you already named:\n      redirects to   ${opts.oauthRedirects.join("\n                     ")}\n`
        : `\n  Client credentials — paste these into the client's own OAuth settings. The redirect URI\n  is whatever that client tells you it wants; paste it back there, and the first time it\n  asks, the card on the approval page names it and your Allow is what permits it.\n      client id      ${opts.clientId}\n      client secret  ${opts.clientSecret}\n`;
    const oauthBlock = opts.oauth
      ? `\n  OAuth is on. A client that speaks it needs only the URL above, and you approve it\n  in the human UI. Anything else can use the bearer token instead.\n      issuer: ${advertisedIssuer}\n${clientBlock}`
      : `\n  OAuth is off, so the client pastes the bearer token above. To let a client authorize\n  itself instead — nothing to copy, you approve it by hand — restart with these and\n  nothing else:\n      --oauth\n`;

    process.stdout.write(rule(`pi-as-mcp is ready — ${scope}`));
    process.stdout.write(`
  MCP URL to paste into the client:
      ${mcpUrl}

  Authorization header:
      Bearer ${token}
${oauthBlock}${humanBlock}
  The agent can read and write under:
      ${opts.root}
`);
    if (probeNote) process.stdout.write(`  tunnel: ${probeNote}\n`);
    process.stdout.write(rule("Ctrl-C stops the bridge and the tunnel"));
    process.stdout.write("\n");

    // The UI is load-bearing whenever it runs: with --oauth it is where the human
    // approves, and an approval nobody notices is a client that hangs.
    if (opts.open && (opts.human || opts.oauth)) openBrowser(uiUrl);
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
