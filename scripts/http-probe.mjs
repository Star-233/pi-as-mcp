import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".tmp-http");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");

const PORT = 8799, TOKEN = "s3cret-token", UI = 8792;
// Isolated from the developer's own ~/.pimcp/config.json: a path that does not
// exist reads as "no file", so the probe tests defaults, not their daily setup.
// --block-ms is short so a call nobody answers is refused within the probe's patience.
const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN,
   "--ui-port", String(UI), "--human", "--approve", "bash", "--block-ms", "4000"],
  { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_AS_MCP_CONFIG: path.resolve(".tmp-probe-config", "none.json") } });
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the server to actually be listening. A fixed sleep is not enough: the
 * server imports Pi's tool graph before it binds, and that takes ~12s when the
 * repository sits on a 9p mount (WSL's /mnt/*), where it takes well under a second
 * on a native filesystem. Polling the port is correct in both cases.
 */
async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited early (code ${child.exitCode})`);
    }
    const ok = await new Promise((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.on("error", () => resolve(false));
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the server never listened on port ${port}\n${logs.join("")}`);
}
await waitForPort(PORT);

const ep = "http://127.0.0.1:" + PORT + "/mcp";
let id = 1;
let failures = 0;
const expect = (ok) => { if (!ok) failures++; };

async function mcp(method, params, token = TOKEN) {
  const res = await fetch(ep, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const body = await res.text();
  if (res.status !== 200) return { http: res.status, raw: body.slice(0, 120) };
  let msg = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5).trim()); } catch {} }
  }
  if (!msg) { try { msg = JSON.parse(body); } catch {} }
  return { http: 200, msg };
}
const firstText = (r) => r?.msg?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
const post = (text) => fetch("http://127.0.0.1:" + UI + "/say", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});

// The page's view of held calls: the approvals event from the same SSE stream a
// browser reads. The newest list wins.
let pendingNow = [];
(async () => {
  const res = await fetch("http://127.0.0.1:" + UI + "/events");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const msg = JSON.parse(line.slice(5));
        if (msg.type === "approvals") pendingNow = msg.pending;
      }
    }
  }
})().catch(() => {});

/** Wait for a held call to show on the page, then answer its card the way a click does. */
async function clickCard(allow) {
  const deadline = Date.now() + 5000;
  while (!pendingNow.length && Date.now() < deadline) await sleep(50);
  const card = pendingNow[0];
  if (!card) return { card: null, status: 0 };
  const r = await fetch("http://127.0.0.1:" + UI + "/approval/decision", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: card.id, allow }),
  });
  // Wait for the page's list to drop the card before the next click.
  const gone = Date.now() + 2000;
  while (pendingNow.some((p) => p.id === card.id) && Date.now() < gone) await sleep(50);
  return { card, status: r.status };
}

try {
  const noAuth = await mcp("tools/list", {}, null);
  console.log("1) no token        ->", noAuth.http === 401 ? "401 unauthorized (correct)" : "*** LEAK: " + JSON.stringify(noAuth));

  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-probe", version: "1" } });
  console.log("2) initialize      ->", init.msg?.result?.serverInfo?.name, "| instructions", (init.msg?.result?.instructions ?? "").length, "chars");

  const list = await mcp("tools/list", {});
  console.log("3) tools/list      ->", list.msg?.result?.tools?.length, "tools");

  // Every tool is gated now: --approve means approval mode "always", read
  // included - a remote model that can read can look around, so the gate is one
  // setting for everything rather than a per-tool list to keep complete.
  const readP = mcp("tools/call", { name: "read", arguments: { path: "a.txt" } });
  const readClick = await clickCard(true);
  const read = await readP;
  console.log("4) read + Allow   ->", readClick.status === 200 ? JSON.stringify(firstText(read)) : "*** no card (" + readClick.status + ")");

  // --- bash approval gate: a card, not the chat ---
  const denyP = mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  const denyClick = await clickCard(false);
  const denied = await denyP;
  console.log("5) bash + Deny    ->", denied.msg?.result?.isError ? "isError: " + firstText(denied).slice(0, 60) : "*** RAN ANYWAY: " + firstText(denied));
  expect(denyClick.status === 200 && denied.msg?.result?.isError === true);

  const allowP = mcp("tools/call", { name: "bash", arguments: { command: "echo approved-and-ran" } });
  const allowClick = await clickCard(true);
  const allowed = await allowP;
  console.log("6) bash + Allow   ->", allowed.msg?.result?.isError ? "ERR " + firstText(allowed) : JSON.stringify(firstText(allowed).trim()));
  expect(allowClick.status === 200 && !allowed.msg?.result?.isError);

  // --- nobody answers: the call is refused when the window closes, not left hanging ---
  const silentP = mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  const silent = await silentP;
  const silentRefused = Boolean(silent.msg?.result?.isError) && firstText(silent).includes("did not approve");
  expect(silentRefused);
  console.log("7) nobody answers ->", silentRefused ? "refused when the window closed" : "*** NOT REFUSED: " + firstText(silent));

  // --- a chat "yes" does not approve a held call: only the card does ---
  const chatP = mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  await sleep(300);
  await post("yes");
  await sleep(300);
  const stillHeld = pendingNow.some((p) => p.summary === "echo SHOULD-NOT-RUN");
  const chatDeny = await clickCard(false);
  const chatRes = await chatP;
  const chatOk = stillHeld && chatDeny.status === 200 && Boolean(chatRes.msg?.result?.isError);
  expect(chatOk);
  console.log("8) chat yes       ->", chatOk ? "held until the card was denied" : "*** CHAT APPROVED OR LOST: " + firstText(chatRes));
  // The chat "yes" is still queued for the human channel; take it now so it does not answer the next question.
  await mcp("tools/call", { name: "human_wait", arguments: { max_block_ms: 1000 } });

  // --- human channel over HTTP ---
  const askP = mcp("tools/call", { name: "human_ask", arguments: { text: "ping?", max_block_ms: 20000 } });
  await sleep(700);
  await post("pong from the human");
  const ask = await askP;
  console.log("9) human_ask       ->", firstText(ask).replace(/\s+/g, " "));

  // --- the merged form of queued messages, over real MCP traffic ---
  await post("line one");
  await post("line two");
  const merged = await mcp("tools/call", { name: "human_wait", arguments: { max_block_ms: 5000 } });
  const payload = JSON.parse(firstText(merged));
  console.log("10) merged answer  ->", JSON.stringify(payload.text));
  expect(payload.count === 2);
  console.log("    count          ->", payload.count);

  console.log("\n--- server log ---");
  console.log(logs.join("").trim());
} catch (e) {
  console.error("PROBE FAILED:", e.message);
  console.error(logs.join("").trim());
  failures++;
} finally {
  child.kill();
  await sleep(200);
}

if (failures) {
  console.error(`\n${failures} http check(s) FAILED`);
  process.exit(1);
}
