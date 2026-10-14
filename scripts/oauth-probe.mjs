import { spawn } from "node:child_process";
import { connect } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Drives the OAuth 2.1 flow the way a real MCP client does, over real HTTP:
 * discovery, dynamic registration, authorization with PKCE, the human's decision,
 * the token exchange, and then an actual MCP call with the access token.
 *
 * The negative cases are the point of most of it. This bridge hands out a shell,
 * so "a code cannot be replayed", "a wrong verifier is refused", "a denial grants
 * nothing" and "the page a client's browser lands on cannot approve anything" are
 * the checks worth having.
 *
 * Usage: node scripts/oauth-probe.mjs
 */

const root = path.resolve(".tmp-oauth");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const PORT = 8801, TOKEN = "static-bearer-token", UI = 8802;
const BASE = `http://127.0.0.1:${PORT}`;
const UI_BASE = `http://127.0.0.1:${UI}`;
const REDIRECT = "http://127.0.0.1:9999/callback";

const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN,
   "--human", "--oauth", "--ui-port", String(UI)],
  { stdio: ["ignore", "pipe", "pipe"] });
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited early (code ${child.exitCode})\n${logs.join("")}`);
    const ok = await new Promise((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.on("error", () => resolve(false));
      sock.on("connect", () => { sock.destroy(); resolve(true); });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the server never listened on port ${port}\n${logs.join("")}`);
}
await waitForPort(PORT);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

/**
 * Requests to the authorization endpoints carry X-Forwarded-For, because behind
 * the tunnel they always do and the SDK rate-limits those endpoints. A proxy header
 * the server has not been told to trust is exactly the kind of thing that turns
 * into a 500 in production and never shows up locally.
 */
const XFF = { "x-forwarded-for": "203.0.113.7" };

const get = (url, headers = {}) => fetch(url, { headers: { ...XFF, ...headers }, redirect: "manual" });
const postForm = (url, fields, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...XFF, ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

async function mcp(method, params, token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.text();
  if (res.status !== 200) return { http: res.status, raw: body.slice(0, 160) };
  let msg = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5).trim()); } catch {} }
  }
  if (!msg) { try { msg = JSON.parse(body); } catch {} }
  return { http: 200, msg };
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

/** Register a client dynamically and return its information. */
async function register(name) {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...XFF },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  return { status: res.status, body: await res.json() };
}

/** Walk /authorize, return the consent page and the id the page polls with. */
async function authorize(clientId, { challenge } = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge ?? pkce().challenge,
    code_challenge_method: "S256",
    state: "state-xyz",
  });
  const res = await get(`${BASE}/authorize?${params}`);
  const page = await res.text();
  const id = page.match(/\/oauth\/pending\?id=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  return { status: res.status, page, id };
}

const pending = (id) => get(`${BASE}/oauth/pending?id=${encodeURIComponent(id)}`).then((r) => r.json());
const exchange = (fields) => postForm(`${BASE}/token`, fields);

try {
  console.log("--- discovery ---");
  const bare = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const challengeHeader = bare.headers.get("www-authenticate") ?? "";
  check("an unauthenticated request is refused", bare.status === 401, `HTTP ${bare.status}`);
  check("the 401 says where to find the metadata",
    challengeHeader.includes("resource_metadata=") &&
      challengeHeader.includes("/.well-known/oauth-protected-resource"), challengeHeader);

  const prm = await get(`${BASE}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  check("protected resource metadata names this server",
    prm.resource === `${BASE}/mcp`, JSON.stringify(prm.resource));

  const asm = await get(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
  // The SDK writes both of these from `URL.href`, which leaves a trailing slash on a
  // bare origin. That is fine as long as the two documents agree: a client resolves
  // the metadata endpoint from `authorization_servers[0]` and then compares the
  // issuer it finds against exactly that string. What would break a client is the
  // two disagreeing, so that is what is asserted.
  check("the resource and the authorization server name the same issuer",
    Array.isArray(prm.authorization_servers) &&
      prm.authorization_servers[0] === asm.issuer,
    `${JSON.stringify(prm.authorization_servers)} vs ${asm.issuer}`);
  check("that issuer is this server", new URL(asm.issuer).origin === BASE, asm.issuer);
  check("authorization server metadata has the endpoints",
    asm.authorization_endpoint === `${BASE}/authorize` && asm.token_endpoint === `${BASE}/token` &&
      asm.registration_endpoint === `${BASE}/register`,
    JSON.stringify({ a: asm.authorization_endpoint, t: asm.token_endpoint, r: asm.registration_endpoint }));
  check("only S256 is advertised (no plain PKCE)",
    JSON.stringify(asm.code_challenge_methods_supported) === JSON.stringify(["S256"]),
    JSON.stringify(asm.code_challenge_methods_supported));

  console.log("\n--- the human is in the loop ---");
  const reg = await register("arena-agent");
  check("a client can register itself", reg.status === 201 && typeof reg.body.client_id === "string",
    `HTTP ${reg.status}`);
  const clientId = reg.body.client_id;

  const first = pkce();
  const auth = await authorize(clientId, { challenge: first.challenge });
  check("/authorize renders a page instead of redirecting", auth.status === 200 && Boolean(auth.id),
    `HTTP ${auth.status}`);
  check("the page names the client and where it would redirect",
    auth.page.includes("arena-agent") && auth.page.includes(REDIRECT));
  check("the page has no way to approve anything",
    !/<button/i.test(auth.page) && !/<form/i.test(auth.page));
  check("the page tells the human to go to the bridge UI", auth.page.includes(`${UI_BASE}/`));

  const waiting = await pending(auth.id);
  check("the request is waiting", waiting.state === "pending", JSON.stringify(waiting));

  const info = await fetch(`${UI_BASE}/info`).then((r) => r.json());
  check("the human UI is told there is something to approve",
    info.oauth?.enabled === true && info.oauth?.grants?.pending === 1,
    JSON.stringify(info.oauth?.grants));

  console.log("\n--- approving ---");
  const decided = await fetch(`${UI_BASE}/oauth/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: auth.id, allow: true }),
  });
  check("the human UI can approve it", decided.status === 200, `HTTP ${decided.status}`);
  const again = await fetch(`${UI_BASE}/oauth/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: auth.id, allow: true }),
  });
  check("approving twice is refused, not honoured twice", again.status === 409, `HTTP ${again.status}`);

  const allowed = await pending(auth.id);
  const code = allowed.redirect && new URL(allowed.redirect).searchParams.get("code");
  check("the waiting browser gets the code and its state back",
    allowed.state === "allowed" && Boolean(code) &&
      new URL(allowed.redirect).searchParams.get("state") === "state-xyz",
    JSON.stringify(allowed).slice(0, 140));

  console.log("\n--- tokens ---");
  const tokens = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: first.verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("the code exchanges for tokens with the right verifier",
    tokens.status === 200 && tokens.body.token_type === "Bearer" &&
      typeof tokens.body.access_token === "string" && typeof tokens.body.refresh_token === "string",
    `HTTP ${tokens.status} ${JSON.stringify(tokens.body).slice(0, 120)}`);
  check("the granted scope is the one this bridge has",
    tokens.body.scope === "mcp", JSON.stringify(tokens.body.scope));

  const replay = await exchange({
    grant_type: "authorization_code", code, code_verifier: first.verifier, client_id: clientId,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("an authorization code cannot be replayed",
    replay.status === 400 && replay.body.error === "invalid_grant",
    `HTTP ${replay.status} ${JSON.stringify(replay.body)}`);

  console.log("\n--- the access token actually works ---");
  const call = await mcp("tools/list", {}, tokens.body.access_token);
  check("an OAuth access token is accepted at /mcp",
    call.http === 200 && Array.isArray(call.msg?.result?.tools) && call.msg.result.tools.length > 0,
    call.http === 200 ? `${call.msg?.result?.tools?.length} tools` : JSON.stringify(call));
  const whoami = await mcp("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-probe", version: "1" },
  }, tokens.body.access_token);
  check("and answers a real MCP handshake", whoami.msg?.result?.serverInfo?.name === "pi-as-mcp",
    JSON.stringify(whoami.msg?.result?.serverInfo));

  const staticStill = await mcp("tools/list", {}, TOKEN);
  check("the static bearer token still works alongside OAuth", staticStill.http === 200);

  const bogus = await mcp("tools/list", {}, "not-a-real-token");
  check("an invented token is still refused", bogus.http === 401, `HTTP ${bogus.http}`);

  console.log("\n--- refresh ---");
  const refreshed = await exchange({
    grant_type: "refresh_token", refresh_token: tokens.body.refresh_token, client_id: clientId,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a refresh token buys a new access token",
    refreshed.status === 200 && refreshed.body.access_token !== tokens.body.access_token,
    `HTTP ${refreshed.status}`);
  const reusedRefresh = await exchange({
    grant_type: "refresh_token", refresh_token: tokens.body.refresh_token, client_id: clientId,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("the rotated refresh token is spent",
    reusedRefresh.status === 400 && reusedRefresh.body.error === "invalid_grant",
    `HTTP ${reusedRefresh.status}`);
  const widened = await exchange({
    grant_type: "refresh_token", refresh_token: refreshed.body.refresh_token,
    client_id: clientId, scope: "admin",
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a refresh cannot widen the scope",
    widened.status === 400 && widened.body.error === "invalid_scope",
    `HTTP ${widened.status} ${JSON.stringify(widened.body)}`);

  console.log("\n--- PKCE and scopes ---");
  const second = pkce();
  const auth2 = await authorize(clientId, { challenge: second.challenge });
  await fetch(`${UI_BASE}/oauth/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: auth2.id, allow: true }),
  });
  const code2 = new URL((await pending(auth2.id)).redirect).searchParams.get("code");
  const wrongVerifier = await exchange({
    grant_type: "authorization_code", code: code2,
    code_verifier: pkce().verifier, client_id: clientId, redirect_uri: REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a wrong code_verifier is refused",
    wrongVerifier.status === 400 && /code_verifier/.test(wrongVerifier.body.error_description ?? ""),
    `HTTP ${wrongVerifier.status} ${JSON.stringify(wrongVerifier.body)}`);

  const badScope = await get(`${BASE}/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}` +
    `&code_challenge_method=S256&scope=admin`);
  check("an unsupported scope is refused as a proper OAuth error redirect",
    badScope.status === 302 &&
      new URL(badScope.headers.get("location")).searchParams.get("error") === "invalid_scope",
    `${badScope.status} ${badScope.headers.get("location")}`);

  console.log("\n--- denying ---");
  const auth3 = await authorize(clientId);
  const denied = await fetch(`${UI_BASE}/oauth/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: auth3.id, allow: false }),
  });
  check("the human UI can deny it", denied.status === 200, `HTTP ${denied.status}`);
  const deniedStatus = await pending(auth3.id);
  check("a denial comes back as access_denied and carries no code",
    deniedStatus.state === "denied" &&
      new URL(deniedStatus.redirect).searchParams.get("error") === "access_denied" &&
      new URL(deniedStatus.redirect).searchParams.get("code") === null,
    JSON.stringify(deniedStatus).slice(0, 160));

  const unknown = await pending("made-up-id");
  check("an unknown request id reveals nothing", unknown.state === "unknown", JSON.stringify(unknown));
  const forgedDecision = await fetch(`${UI_BASE}/oauth/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "made-up-id", allow: true }),
  });
  check("a forged decision is refused", forgedDecision.status === 409, `HTTP ${forgedDecision.status}`);

  console.log("\n--- untrusted text on the consent page ---");
  const nasty = await register('<img src=x onerror="alert(1)">');
  const nastyAuth = await authorize(nasty.body.client_id);
  check("a hostile client name is escaped, not rendered",
    !/<img/i.test(nastyAuth.page) && nastyAuth.page.includes("&lt;img"), "consent page");

  console.log("\n--- server log ---");
  console.log(logs.join("").trim());
} catch (e) {
  console.error("PROBE FAILED:", e.stack ?? e.message);
  console.error(logs.join("").trim());
  failures++;
} finally {
  child.kill();
  await sleep(200);
}

if (failures) {
  console.error(`\n${failures} oauth check(s) FAILED`);
  process.exit(1);
}
console.log("\nall oauth checks passed");
