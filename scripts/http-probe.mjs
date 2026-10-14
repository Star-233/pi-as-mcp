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
const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN,
   "--ui-port", String(UI), "--human", "--approve", "bash"],
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
  await sleep(700);
  await post("yes");
  const read = await readP;
  console.log("4) read + approve  ->", JSON.stringify(firstText(read)));

  // --- bash approval gate (fail closed) ---
  const denyP = mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  await sleep(700);
  await post("no way");
  const denied = await denyP;
  console.log("5) bash + deny     ->", denied.msg?.result?.isError ? "isError: " + firstText(denied).slice(0, 60) : "*** RAN ANYWAY: " + firstText(denied));

  const allowP = mcp("tools/call", { name: "bash", arguments: { command: "echo approved-and-ran" } });
  await sleep(700);
  await post("yes");
  const allowed = await allowP;
  console.log("6) bash + approve  ->", allowed.msg?.result?.isError ? "ERR " + firstText(allowed) : JSON.stringify(firstText(allowed).trim()));

  // --- approval with nobody answering must fail closed, not hang forever ---
  console.log("7) waiting without replying (block cap 90s is too long for a probe; skipping long wait)");

  // --- human channel over HTTP ---
  const askP = mcp("tools/call", { name: "human_ask", arguments: { text: "ping?", max_block_ms: 20000 } });
  await sleep(700);
  await post("pong from the human");
  const ask = await askP;
  console.log("8) human_ask       ->", firstText(ask).replace(/\s+/g, " "));

  // --- the approval gate against a queued, multi-message answer ---
  // The gate drains the queue like everything else, so it has to judge every line.
  // A retraction anywhere must deny; so must anything unrecognised.
  await post("yes");
  await post("no, wait");
  const retract = await mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  const deniedRetract = Boolean(retract.msg?.result?.isError);
  expect(deniedRetract);
  console.log("9) queued yes+no   ->", deniedRetract ? "denied, the retraction wins" : "*** RAN: " + firstText(retract));

  await post("no");
  await post("yes");
  const flip = await mcp("tools/call", { name: "bash", arguments: { command: "echo SHOULD-NOT-RUN" } });
  const deniedFlip = Boolean(flip.msg?.result?.isError);
  expect(deniedFlip);
  console.log("10) queued no+yes  ->", deniedFlip ? "denied, fails closed on any doubt" : "*** RAN: " + firstText(flip));

  await post("yes");
  await post("ok");
  const both = await mcp("tools/call", { name: "bash", arguments: { command: "echo both-approved" } });
  const ranBoth = !both.msg?.result?.isError;
  expect(ranBoth);
  console.log("11) queued yes+ok  ->", ranBoth ? JSON.stringify(firstText(both).trim()) : "*** DENIED: " + firstText(both));

  // --- and the merged form itself, over real MCP traffic ---
  await post("line one");
  await post("line two");
  const merged = await mcp("tools/call", { name: "human_wait", arguments: { max_block_ms: 5000 } });
  const payload = JSON.parse(firstText(merged));
  console.log("12) merged answer  ->", JSON.stringify(payload.text));
  expect(payload.count === 2);
  console.log("    count          ->", payload.count);

  console.log("\n--- server log ---");
  console.log(logs.join("").trim());
} catch (e) {
  console.error("PROBE FAILED:", e.message);
  console.error(logs.join("").trim());
} finally {
  child.kill();
  await sleep(200);
}

if (failures) {
  console.error(`\n${failures} http check(s) FAILED`);
  process.exit(1);
}
