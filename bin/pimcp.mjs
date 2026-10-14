#!/usr/bin/env node
/**
 * pimcp — run the pi-as-mcp bridge from any directory with one short command.
 *
 *   cd <the directory the agent should work in>
 *   pimcp
 *
 * Starts the MCP server rooted at the current directory, picks free ports, mints a
 * bearer token, opens a Cloudflare quick tunnel, waits for cloudflared to register
 * with the edge, and prints a paste-ready MCP URL. Ctrl-C stops everything.
 *
 * The tunnel is on by default because the whole point is reaching a cloud agent.
 * Use --no-tunnel to keep it on localhost.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "src", "index.ts");
const SUPERVISE = path.join(REPO, "bin", "supervise.mjs");

const HELP = `
pimcp — start the pi-as-mcp bridge for the current directory.

USAGE
  pimcp [options]

The current working directory becomes --root: the agent can read and write there and
nowhere else. Run it from the directory you want the agent to work in.

OPTIONS
  --no-tunnel          Do not start a Cloudflare tunnel (localhost only).
  --root <dir>         Override the sandbox root (default: current directory).
  --token <token>      Use this bearer token instead of a generated one.
  --port <n>           MCP HTTP port (default: 8777, or a free one if taken).
  --ui-port <n>        Human web UI port (default: 8790, or a free one if taken).
  --no-open            Do not open the browser automatically.
  -h, --help           Show this help.

Passed through to the server:
  --human              Expose the human channel: human_say/ask/wait, the web UI and
                       the approval gate. Off by default.
  --no-human           Explicitly keep it off (the default; spelled out for clarity).
  --oauth              Serve an OAuth 2.1 authorization server in front of /mcp, so a
                       client can authorize itself instead of being handed a token.
                       ON by default; --no-oauth turns it off. Uses a pre-registered
                       client with --oauth-redirect, and dynamic registration without it.
  --no-oauth           Do not run the authorization server (clients then need the token).
  --oauth-redirect <uri>
                       Register ONE client allowed to return to this URI, and print the
                       client id and secret to paste into that client's own OAuth
                       settings. This is how a hosted client (Gemini's "custom connected
                       app") is added: it will never register itself. Comma-separated for
                       several URIs. Minted fresh each run unless the two flags below pin it.
  --oauth-client-id <id>
  --oauth-client-secret <secret>
                       Pin the credentials above, so a restart does not invalidate a pair
                       that has already been pasted into a client. Needs --oauth-redirect.
  --issuer <url>       The URL clients reach, e.g. https://mcp.example.com. Only with
                       --oauth. Defaults to the quick-tunnel hostname, or to
                       http://127.0.0.1:<port> when there is no tunnel.
  --approve <tools>    Require human approval before these tools run, e.g. bash.
                       Needs --human.
  --deny <paths>       Extra paths to refuse even inside the root.
  --tools <list>       Expose only this comma-separated subset.
  --block-ms <n>       Max time human_ask/human_wait block (default 90000).
`;

const PASSTHROUGH_VALUE_FLAGS = new Set([
  "--approve",
  "--deny",
  "--tools",
  "--block-ms",
  "--host",
  "--ui-host",
  "--ui-token",
  "--issuer",
]);
// Value-less flags the server understands, forwarded verbatim.
const PASSTHROUGH_BOOL_FLAGS = new Set(["--human", "--oauth"]);

function parseArgs(argv) {
  const opts = {
    tunnel: true,
    open: true,
    human: false,
    // On by default, unlike the server's own flag: the launcher's job is the
    // remote-agent case, where the client needs some way in and an authorization
    // it grants itself beats a token pasted between two chat windows.
    oauth: true,
    oauthRedirects: [],
    clientId: null,
    clientSecret: null,
    root: process.cwd(),
    token: null,
    issuer: null,
    port: 8777,
    uiPort: 8790,
    passthrough: [],
    help: false,
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
  // cannot leave an --oauth behind that the server would then have to reject.
  if (opts.human) opts.passthrough.push("--human");
  if (opts.clientId || opts.clientSecret) {
    if (!opts.oauthRedirects.length) {
      throw new Error(
        "--oauth-client-id/--oauth-client-secret name the client that --oauth-redirect registers, " +
          "so they need --oauth-redirect too.",
      );
    }
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error(
        "--oauth-client-id and --oauth-client-secret have to be given together: pinning one and " +
          "minting the other would break the pair a client has already been configured with.",
      );
    }
  }
  if (opts.oauth) {
    opts.passthrough.push("--oauth");
    if (opts.oauthRedirects.length) {
      opts.passthrough.push("--oauth-redirect", opts.oauthRedirects.join(","));
      // Minted here rather than in the server, because this process prints the
      // banner the human copies from - the same reason it mints the bearer token.
      opts.clientId = opts.clientId || `pimcp-${randomBytes(9).toString("base64url")}`;
      opts.clientSecret = opts.clientSecret || randomBytes(32).toString("base64url");
      opts.passthrough.push("--oauth-client-id", opts.clientId, "--oauth-client-secret", opts.clientSecret);
    }
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bind-and-release: true if the port is usable on loopback. */
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

/**
 * Spawn through bin/supervise.mjs so the child dies with us even if we are
 * hard-killed — otherwise a kill can orphan the server and an open public tunnel.
 */
function supervise(command, args, opts) {
  return spawn(
    process.execPath,
    [SUPERVISE, "--parent-pid", String(process.pid), "--", command, ...args],
    opts,
  );
}

function startServer({ root, port, uiPort, token, issuer, passthrough }) {
  const args = [
    ENTRY,
    "--root", root,
    "--http",
    "--port", String(port),
    "--ui-port", String(uiPort),
    "--token", token,
    ...passthrough,
  ];
  if (issuer) args.push("--issuer", issuer);
  const child = supervise(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], cwd: root });
  let buf = "";
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      if (buf.includes("[pi-as-mcp] ready")) resolve();
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      process.stdout.write(d);
      check();
    });
    child.stderr.on("data", (d) => {
      buf += d.toString();
      process.stderr.write(d);
      check();
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the server exited early (code ${code})`)));
    setTimeout(() => reject(new Error("timed out waiting for the server to become ready")), 30000);
  });
  return { child, ready };
}

/**
 * The quick-tunnel hostname appears in cloudflared's output *before* the edge
 * connection is up, so the URL alone proves nothing. The reliable signal is
 * cloudflared logging that it registered a tunnel connection.
 */
function startTunnel(port) {
  const child = supervise(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let log = "";
  let settleUrl = null;
  let settleRegistered = null;
  const url = new Promise((r) => (settleUrl = r));
  const registered = new Promise((r) => (settleRegistered = r));

  const onData = (d) => {
    log += d.toString();
    if (settleUrl) {
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { settleUrl(m[0]); settleUrl = null; }
    }
    if (settleRegistered && /Registered tunnel connection/i.test(log)) {
      settleRegistered(true);
      settleRegistered = null;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    const msg = e.code === "ENOENT" ? "cloudflared is not on PATH" : e.message;
    if (settleUrl) { settleUrl(null); settleUrl = null; }
    if (settleRegistered) { settleRegistered(false); settleRegistered = null; }
    process.stderr.write(`  ${msg}\n`);
  });
  child.on("exit", (code) => {
    if (settleUrl) { settleUrl(null); settleUrl = null; }
    if (settleRegistered) { settleRegistered(false); settleRegistered = null; }
    if (code !== 0) process.stderr.write(`  cloudflared exited (code ${code})\n`);
  });

  setTimeout(() => { if (settleUrl) { settleUrl(null); settleUrl = null; } }, 45000);
  setTimeout(() => { if (settleRegistered) { settleRegistered(false); settleRegistered = null; } }, 60000);

  return { child, url, registered, log: () => log };
}

/**
 * Start a quick tunnel and wait for its hostname. A missing hostname is reported
 * here, once, because it is the same outcome whether the tunnel was opened early
 * (for --oauth) or late.
 */
async function openTunnel(port) {
  process.stdout.write("  opening a Cloudflare tunnel…\n");
  const t = startTunnel(port);
  const base = await t.url;
  if (!base) {
    process.stderr.write("  could not get a tunnel URL — falling back to localhost only.\n");
    process.stderr.write(t.log().split("\n").slice(-10).map((l) => `    ${l}\n`).join(""));
  }
  return { tunnel: t, base };
}

/**
 * Advisory only. On a machine behind a fake-IP TUN proxy, reaching your own
 * public URL can fail (ECONNRESET / HTTP 000) while the tunnel is perfectly
 * healthy for remote clients — so a failure here must not be treated as fatal.
 */
async function probeOnce(mcpUrl) {
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pimcp", version: "1" },
        },
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
  } catch {
    /* not fatal */
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function rule(label) {
  const line = "─".repeat(72);
  return `\n${line}\n  ${label}\n${line}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
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

  let tunnelUp = false;
  let probeNote = null;

  try {
    process.stdout.write(`\n  starting pi-as-mcp for ${opts.root}\n`);

    // With --oauth the tunnel has to be up *before* the server starts. The
    // authorization server advertises a single issuer in its metadata, and a client
    // checks that against the address it actually reached — so it has to be the
    // public hostname, which exists only once cloudflared has printed it.
    let publicBase = null;
    if (opts.tunnel && opts.oauth && !opts.issuer) {
      const opened = await openTunnel(port);
      tunnel = opened.tunnel;
      publicBase = opened.base;
    }

    const issuer = opts.oauth ? opts.issuer ?? publicBase : null;
    server = startServer({ root: opts.root, port, uiPort, token, issuer, passthrough: opts.passthrough });
    await server.ready;

    let publicMcp = null;
    if (opts.tunnel) {
      if (!tunnel) {
        const opened = await openTunnel(port);
        tunnel = opened.tunnel;
        publicBase = opened.base;
      }
      if (publicBase) {
        process.stdout.write(`  tunnel url ${publicBase} — waiting for the edge connection…\n`);
        tunnelUp = await tunnel.registered;
        if (tunnelUp) {
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
      : opts.tunnel
        ? "LOCALHOST ONLY — the tunnel did not come up"
        : "LOCALHOST ONLY";

    // The UI runs when the human channel is on, and also when only --oauth is: it
    // is where an authorization is approved. So its URL is worth printing for
    // either reason, and the two reasons read very differently.
    const humanBlock = opts.human
      ? `
  Human channel — open this, it is where the agent talks to you:
      ${uiUrl}
`
      : opts.oauth
        ? `
  Approve access here — this page is the only place an authorization can be granted:
      ${uiUrl}
`
        : `
  Human channel: off. Restart with --human for human_say/ask/wait and the web UI.
`;
    // The banner has to name what the server will actually advertise. The server runs
    // the issuer through `new URL(...)` — which adds the root slash — and falls back to
    // loopback when the launcher passes none, so this mirrors both. Printing the raw
    // option showed `issuer: null` for `--oauth --no-tunnel`, which is a value no client
    // could ever have used.
    const advertisedIssuer = opts.oauth
      ? new URL(issuer ?? `http://127.0.0.1:${port}`).href
      : null;
    // A client that registers itself needs none of this. One configured by hand needs
    // all of it, and this is the only copy that exists, so it is printed in full.
    const clientBlock = opts.oauth && opts.oauthRedirects.length
      ? `
  Client credentials — paste these into the client's own OAuth settings, then add the
  redirect URI it shows you below to that client's allowed list:
      client id      ${opts.clientId}
      client secret  ${opts.clientSecret}
      redirects to   ${opts.oauthRedirects.join("\n                     ")}
`
      : "";
    const oauthBlock = opts.oauth
      ? `
  OAuth is on. A client that speaks it needs only the URL above, and you approve it
  in the human UI. Anything else can use the bearer token instead.
      issuer: ${advertisedIssuer}
${clientBlock}`
      : `
  OAuth is off, so the client pastes the bearer token above. To let a client authorize
  itself instead — nothing to copy, you approve it by hand — restart with:
      pimcp ${opts.human ? "--oauth" : "--human --oauth"}
`;
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
    process.stdout.write(rule("Ctrl-C stops the server and the tunnel"));
    process.stdout.write("\n");

    // The UI is load-bearing whenever it is running: with --oauth it is where the
    // human approves, and an approval nobody notices is a client that hangs.
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
