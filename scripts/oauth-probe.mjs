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
 * The last two sections each run a *second* (and third) server, because the shape
 * of the client decides the shape of the flow. The second is a hosted product's
 * "custom connected app": a pre-registered confidential client that never
 * registers itself, sends no PKCE, and whose redirect URI the operator named up
 * front. The third is the default - the pair is printed and no address is known in
 * advance - which is what plain `pimcp` produces, and where the address has to come
 * from the client and be permitted by the human's own click.
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
  { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_AS_MCP_CONFIG: path.resolve(".tmp-probe-config", "none.json") } });
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(child, port, logs, timeoutMs = 60000) {
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
await waitForPort(child, PORT, logs);

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

async function mcp(base, method, params, token) {
  const res = await fetch(`${base}/mcp`, {
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

/** The human clicking Allow (or Deny) on the local UI, at `uiBase`. */
const approve = (uiBase, id, allow = true) =>
  fetch(`${uiBase}/oauth/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, allow }),
  });

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
  // The pair a person configures a client with is printed by default, with no flag
  // asking for it and no redirect URI known in advance - which is the only shape that
  // works for a product that shows you its callback address after you have already
  // pasted the credentials in.
  const firstLog = logs.join("");
  check("a client id and secret are printed without being asked for",
    /oauth: client id\s+\S+/.test(firstLog) && /oauth: client secret\s+\S+/.test(firstLog),
    firstLog.split("\n").filter((l) => l.includes("oauth: client")).map((l) => l.trim()).join(" | ") ||
      "(no credential lines)");
  check("and the log says no redirect URI is known in advance",
    firstLog.includes("no redirect URI is set up in advance"),
    firstLog.split("\n").find((l) => l.includes("redirect URI"))?.trim() ?? "(no line)");

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
  const decided = await approve(UI_BASE, auth.id);
  check("the human UI can approve it", decided.status === 200, `HTTP ${decided.status}`);
  const again = await approve(UI_BASE, auth.id);
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
  const call = await mcp(BASE, "tools/list", {}, tokens.body.access_token);
  check("an OAuth access token is accepted at /mcp",
    call.http === 200 && Array.isArray(call.msg?.result?.tools) && call.msg.result.tools.length > 0,
    call.http === 200 ? `${call.msg?.result?.tools?.length} tools` : JSON.stringify(call));
  const whoami = await mcp(BASE, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-probe", version: "1" },
  }, tokens.body.access_token);
  check("and answers a real MCP handshake", whoami.msg?.result?.serverInfo?.name === "pi-as-mcp",
    JSON.stringify(whoami.msg?.result?.serverInfo));

  const staticStill = await mcp(BASE, "tools/list", {}, TOKEN);
  check("the static bearer token still works alongside OAuth", staticStill.http === 200);

  const bogus = await mcp(BASE, "tools/list", {}, "not-a-real-token");
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
  await approve(UI_BASE, auth2.id);
  const code2 = new URL((await pending(auth2.id)).redirect).searchParams.get("code");
  const wrongVerifier = await exchange({
    grant_type: "authorization_code", code: code2,
    code_verifier: pkce().verifier, client_id: clientId, redirect_uri: REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a wrong code_verifier is refused",
    wrongVerifier.status === 400 && /code_verifier/.test(wrongVerifier.body.error_description ?? ""),
    `HTTP ${wrongVerifier.status} ${JSON.stringify(wrongVerifier.body)}`);

  // A hosted client asks for whatever its own platform taught it to ask for, so a
  // scope this bridge does not have is narrowed rather than refused - RFC 6749 §3.3
  // allows issuing less than was requested. What it must never do is grant more, so
  // what is asserted is the scope on the token, not just the page.
  const broader = pkce();
  const asked = await get(`${BASE}/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${broader.challenge}` +
    `&code_challenge_method=S256&state=s9&scope=admin`);
  const askedPage = await asked.text();
  check("an unknown scope is narrowed, not an error", asked.status === 200, `HTTP ${asked.status}`);
  check("the page says what will not be granted", askedPage.includes("admin"), "consent page");
  const askedId = askedPage.match(/\/oauth\/pending\?id=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  await approve(UI_BASE, askedId);
  const askedCode = new URL((await pending(askedId)).redirect).searchParams.get("code");
  const narrowed = await exchange({
    grant_type: "authorization_code", code: askedCode,
    code_verifier: broader.verifier, client_id: clientId, redirect_uri: REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("and the token carries only the scope this bridge has",
    narrowed.status === 200 && narrowed.body.scope === "mcp",
    `HTTP ${narrowed.status} ${JSON.stringify(narrowed.body.scope)}`);

  console.log("\n--- denying ---");
  const auth3 = await authorize(clientId);
  const denied = await approve(UI_BASE, auth3.id, false);
  check("the human UI can deny it", denied.status === 200, `HTTP ${denied.status}`);
  const deniedStatus = await pending(auth3.id);
  check("a denial comes back as access_denied and carries no code",
    deniedStatus.state === "denied" &&
      new URL(deniedStatus.redirect).searchParams.get("error") === "access_denied" &&
      new URL(deniedStatus.redirect).searchParams.get("code") === null,
    JSON.stringify(deniedStatus).slice(0, 160));

  const unknown = await pending("made-up-id");
  check("an unknown request id reveals nothing", unknown.state === "unknown", JSON.stringify(unknown));
  const forgedDecision = await approve(UI_BASE, "made-up-id");
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

/**
 * A second server, configured the way a *hosted* client has to be.
 *
 * Gemini's "custom connected app" asks the human for a client id, a client secret
 * and a redirect URI, which means the client never calls /register and is never
 * told what this bridge's scope is called. So this is the shape that has to work:
 * a pre-registered confidential client, no --human (the UI is only an approval
 * console here), and no PKCE - the client sends no code_challenge and no
 * code_verifier at all.
 */
const PORT2 = 8811, UI2 = 8812;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const UI2_BASE = `http://127.0.0.1:${UI2}`;
const HOSTED_REDIRECT = "https://oauth-redirect.example.com/r/bridge-probe";
const CLIENT_ID = "pimcp-probe-client";
const CLIENT_SECRET = "probe-client-secret";

const hosted = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT2), "--ui-port", String(UI2),
   "--oauth", "--oauth-redirect", HOSTED_REDIRECT,
   "--oauth-client-id", CLIENT_ID, "--oauth-client-secret", CLIENT_SECRET],
  { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_AS_MCP_CONFIG: path.resolve(".tmp-probe-config", "none.json") } });
const hostedLogs = [];
hosted.stderr.on("data", (d) => hostedLogs.push(d.toString()));

try {
  await waitForPort(hosted, PORT2, hostedLogs);

  console.log("\n--- a client configured by hand: no PKCE, no registration ---");
  check("--oauth works without --human", hostedLogs.join("").includes("approval UI:"),
    hostedLogs.join("").split("\n").find((l) => l.includes("human channel"))?.trim() ?? "");

  const hostedInfo = await fetch(`${UI2_BASE}/info`).then((r) => r.json());
  check("the page is up and says it is standing in for approvals only",
    hostedInfo.oauth?.enabled === true && hostedInfo.human === false,
    JSON.stringify({ oauth: hostedInfo.oauth?.enabled, human: hostedInfo.human }));
  check("and one client is already registered", hostedInfo.oauth?.grants?.clients === 1,
    JSON.stringify(hostedInfo.oauth?.grants));

  // No code_challenge at all - this is the whole point of the section.
  const noPkce = await get(`${BASE2}/authorize?response_type=code&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(HOSTED_REDIRECT)}&state=hosted-1&scope=openid%20email`);
  const noPkcePage = await noPkce.text();
  check("a client that sends no PKCE still gets the consent page",
    noPkce.status === 200, `HTTP ${noPkce.status}`);
  check("the card names the client by where it redirects",
    noPkcePage.includes("oauth-redirect.example.com"), "consent page");
  const hostedId = noPkcePage.match(/\/oauth\/pending\?id=([A-Za-z0-9_-]+)/)?.[1] ?? null;

  const hostedPending = await get(`${BASE2}/oauth/pending?id=${hostedId}`).then((r) => r.json());
  check("it is waiting for the human", hostedPending.state === "pending", JSON.stringify(hostedPending));
  // The only account of what a client actually sent: it is on the other end of a
  // redirect the human never sees, so a failed flow is undiagnosable without this.
  check("the server logs what the client sent, PKCE included",
    /oauth: \/authorize from pimcp-probe-client, pkce none, scope "openid email"/.test(hostedLogs.join("")),
    hostedLogs.join("").split("\n").filter((l) => l.includes("/authorize")).pop()?.trim() ?? "(no line)");

  await approve(UI2_BASE, hostedId);
  const hostedStatus = await get(`${BASE2}/oauth/pending?id=${hostedId}`).then((r) => r.json());
  const hostedCode = new URL(hostedStatus.redirect).searchParams.get("code");
  check("approving hands the browser a code", Boolean(hostedCode),
    JSON.stringify(hostedStatus).slice(0, 120));

  const hostedTokens = await postForm(`${BASE2}/token`, {
    grant_type: "authorization_code", code: hostedCode, client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, redirect_uri: HOSTED_REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("the secret in the body buys tokens with no code_verifier",
    hostedTokens.status === 200 && typeof hostedTokens.body.access_token === "string",
    `HTTP ${hostedTokens.status} ${JSON.stringify(hostedTokens.body).slice(0, 120)}`);
  check("and the granted scope is this bridge's own, not what was asked for",
    hostedTokens.body.scope === "mcp", JSON.stringify(hostedTokens.body.scope));

  const hostedCall = await mcp(BASE2, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hosted-probe", version: "1" },
  }, hostedTokens.body.access_token);
  check("that token opens /mcp", hostedCall.http === 200, `HTTP ${hostedCall.http}`);
  const hostedTools = await mcp(BASE2, "tools/list", {}, hostedTokens.body.access_token);
  const names = (hostedTools.msg?.result?.tools ?? []).map((t) => t.name);
  check("and offers no human_* tool, because --human was not given",
    names.length > 0 && !names.some((n) => n.startsWith("human_")), names.join(","));

  console.log("\n--- the secret is actually checked ---");
  const wrongSecret = await postForm(`${BASE2}/token`, {
    grant_type: "refresh_token", refresh_token: hostedTokens.body.refresh_token,
    client_id: CLIENT_ID, client_secret: "not-the-secret",
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a wrong client_secret is refused",
    wrongSecret.status === 401 && wrongSecret.body.error === "invalid_client",
    `HTTP ${wrongSecret.status} ${JSON.stringify(wrongSecret.body)}`);
  const noSecret = await postForm(`${BASE2}/token`, {
    grant_type: "refresh_token", refresh_token: hostedTokens.body.refresh_token, client_id: CLIENT_ID,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("so is omitting it", noSecret.status === 401 && noSecret.body.error === "invalid_client",
    `HTTP ${noSecret.status}`);

  // HTTP Basic is the other half of RFC 6749 §2.3.1, and which one a hosted client
  // uses is not this bridge's decision to make.
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const basicRefresh = await postForm(`${BASE2}/token`,
    { grant_type: "refresh_token", refresh_token: hostedTokens.body.refresh_token },
    { authorization: `Basic ${basic}` }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("the same secret as HTTP Basic also works",
    basicRefresh.status === 200 && typeof basicRefresh.body.access_token === "string",
    `HTTP ${basicRefresh.status} ${JSON.stringify(basicRefresh.body).slice(0, 100)}`);

  console.log("\n--- a hand-configured client is still not a bypass ---");
  const wrongRedirect = await get(`${BASE2}/authorize?response_type=code&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent("https://attacker.example.com/steal")}`);
  check("an unregistered redirect_uri is refused outright",
    wrongRedirect.status === 400, `HTTP ${wrongRedirect.status}`);

  const hostedReg = await fetch(`${BASE2}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...XFF },
    body: JSON.stringify({ client_name: "public one", redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("a client can still register itself alongside the static one", hostedReg.status === 201,
    `HTTP ${hostedReg.status}`);
  const publicNoPkce = await get(`${BASE2}/authorize?response_type=code` +
    `&client_id=${hostedReg.body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`);
  check("but a public client without PKCE is still turned away",
    publicNoPkce.status === 302 &&
      new URL(publicNoPkce.headers.get("location")).searchParams.get("error") === "invalid_request",
    `${publicNoPkce.status} ${publicNoPkce.headers.get("location")}`);

  console.log("\n--- server log (hosted shape) ---");
  console.log(hostedLogs.join("").trim());
} catch (e) {
  console.error("HOSTED PROBE FAILED:", e.stack ?? e.message);
  console.error(hostedLogs.join("").trim());
  failures++;
} finally {
  hosted.kill();
  await sleep(200);
}

/**
 * A third server, in the shape `pimcp` produces by default: a printed credential
 * pair, and *no* redirect URI known in advance.
 *
 * That last part is not a shortcut, it is the only possibility. A product that asks
 * you to paste a client id and secret into it shows you its callback address in the
 * same dialog - after the bridge is already running, so there was never a moment at
 * which it could have been registered. Refusing the address means such a client can
 * never finish; accepting it silently means nobody ever looked at it. So it is
 * accepted *and shown*, and only the human's click on that address allows it.
 *
 * The deny cases are what keep this from being an open redirect: a public client
 * gets no such path (no secret means the exact match is all that protects its code),
 * and the permission is per address, not per client.
 */
const PORT3 = 8821, UI3 = 8822;
const BASE3 = `http://127.0.0.1:${PORT3}`;
const UI3_BASE = `http://127.0.0.1:${UI3}`;
const DEFAULT_ID = "pimcp-probe-default";
const DEFAULT_SECRET = "probe-default-secret";
const LATE_REDIRECT = "https://client.example.com/oauth/callback";
const LATER_REDIRECT = "https://client.example.com/oauth/other";

// The pair is pinned so the probe knows what to send - which is exactly what the
// launcher does now that it mints them itself. No --oauth-redirect: the address is
// not known yet, which is the whole point of this section.
const plainSpawn = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT3), "--ui-port", String(UI3),
   "--oauth", "--oauth-client-id", DEFAULT_ID, "--oauth-client-secret", DEFAULT_SECRET],
  { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_AS_MCP_CONFIG: path.resolve(".tmp-probe-config", "none.json") } });
const plainLogs = [];
plainSpawn.stderr.on("data", (d) => plainLogs.push(d.toString()));

const warning = "was <strong>not</strong> set up in advance";

try {
  await waitForPort(plainSpawn, PORT3, plainLogs);

  console.log("\n--- the default shape: credentials, and a redirect URI that is not known yet ---");
  check("a pinned pair with no --oauth-redirect starts instead of exiting",
    plainLogs.join("").includes(`oauth: client id     ${DEFAULT_ID}`),
    plainLogs.join("").split("\n").filter((l) => l.includes("client id")).map((l) => l.trim()).join(" | "));

  const arrive = (redirect, extra = "") =>
    get(`${BASE3}/authorize?response_type=code&client_id=${DEFAULT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirect)}&state=late-1${extra}`).then(async (r) => ({
      status: r.status,
      page: await r.text(),
    }));

  const first = await arrive(LATE_REDIRECT, "&scope=openid%20profile");
  check("a client that names its address for the first time gets the consent page",
    first.status === 200, `HTTP ${first.status}`);
  check("and the page says the address was never set up in advance",
    first.page.includes(warning) && first.page.includes(LATE_REDIRECT), "consent page");
  check("the server log says the same thing where an operator can read it",
    /asked to be sent to an address it was not configured with/.test(plainLogs.join("")),
    plainLogs.join("").split("\n").filter((l) => l.includes("not configured with")).pop()?.trim() ?? "(no line)");

  const firstId = first.page.match(/\/oauth\/pending\?id=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  await approve(UI3_BASE, firstId);
  const firstCode = new URL((await get(`${BASE3}/oauth/pending?id=${firstId}`).then((r) => r.json()))
    .redirect).searchParams.get("code");
  const lateTokens = await postForm(`${BASE3}/token`, {
    grant_type: "authorization_code", code: firstCode, client_id: DEFAULT_ID,
    client_secret: DEFAULT_SECRET, redirect_uri: LATE_REDIRECT,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  check("approving it buys tokens with the printed secret and no PKCE",
    lateTokens.status === 200 && lateTokens.body.scope === "mcp",
    `HTTP ${lateTokens.status} ${JSON.stringify(lateTokens.body).slice(0, 120)}`);
  const lateCall = await mcp(BASE3, "tools/list", {}, lateTokens.body.access_token);
  check("and that token opens /mcp", lateCall.http === 200 &&
    Array.isArray(lateCall.msg?.result?.tools), `HTTP ${lateCall.http}`);

  // Approving an address is what registers it, so the second request from the same
  // address is an ordinary one. The warning is a prompt, not a permanent banner.
  const again = await arrive(LATE_REDIRECT);
  check("the same address a second time is no longer flagged as new",
    again.status === 200 && !again.page.includes(warning), `HTTP ${again.status}`);

  const elsewhere = await arrive(LATER_REDIRECT);
  check("but a different address is flagged again - the permission is per address",
    elsewhere.status === 200 && elsewhere.page.includes(warning), `HTTP ${elsewhere.status}`);
  const elsewhereId = elsewhere.page.match(/\/oauth\/pending\?id=([A-Za-z0-9_-]+)/)?.[1] ?? null;
  await approve(UI3_BASE, elsewhereId, false);

  // Learning is tied to there being a secret to lose. A public client has only the
  // exact match keeping its code from being delivered somewhere else.
  const publicReg = await fetch(`${BASE3}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...XFF },
    body: JSON.stringify({ client_name: "public default", redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  }).then(async (r) => r.json());
  const publicLate = await get(`${BASE3}/authorize?response_type=code` +
    `&client_id=${publicReg.client_id}&redirect_uri=${encodeURIComponent(LATE_REDIRECT)}` +
    `&state=p&code_challenge=${pkce().challenge}&code_challenge_method=S256`);
  check("a public client is given no such path: an unregistered address is refused",
    publicLate.status === 400, `HTTP ${publicLate.status}`);

  console.log("\n--- server log (default shape) ---");
  console.log(plainLogs.join("").trim());
} catch (e) {
  console.error("DEFAULT-SHAPE PROBE FAILED:", e.stack ?? e.message);
  console.error(plainLogs.join("").trim());
  failures++;
} finally {
  plainSpawn.kill();
  await sleep(200);
}

if (failures) {
  console.error(`\n${failures} oauth check(s) FAILED`);
  process.exit(1);
}
console.log("\nall oauth checks passed");
