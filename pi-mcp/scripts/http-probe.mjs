import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".tmp-http");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");

const PORT = 8799, TOKEN = "s3cret-token", UI = 8792;
const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN,
   "--ui-port", String(UI), "--approve", "bash"],
  { stdio: ["ignore", "pipe", "pipe"] });
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

const ep = "http://127.0.0.1:" + PORT + "/mcp";
let id = 1;

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

  const read = await mcp("tools/call", { name: "read", arguments: { path: "a.txt" } });
  console.log("4) read            ->", JSON.stringify(firstText(read)));

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

  console.log("\n--- server log ---");
  console.log(logs.join("").trim());
} catch (e) {
  console.error("PROBE FAILED:", e.message);
  console.error(logs.join("").trim());
} finally {
  child.kill();
}
