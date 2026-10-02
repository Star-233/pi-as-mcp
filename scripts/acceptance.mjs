/**
 * Human acceptance for pi-mcp. Runs the real server and drives it exactly the way a
 * remote agent would, so you only have to watch the browser and type one answer.
 *
 *   node scripts/acceptance.mjs            # waits up to 10 minutes for your reply
 *   node scripts/acceptance.mjs --auto 3   # self-test: answers itself after 3s
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const autoIdx = process.argv.indexOf("--auto");
const autoDelay = autoIdx >= 0 ? Number(process.argv[autoIdx + 1] ?? 3) * 1000 : 0;

const root = path.resolve(".acceptance-tmp");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "sample.txt"), "pi-mcp acceptance sample\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryPort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen(preferred, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function port(preferred) {
  return (await tryPort(preferred)) ?? (await tryPort(0));
}

const PORT = await port(8777);
const UI = await port(8790);
const TOKEN = "acceptance-token";
const uiUrl = `http://127.0.0.1:${UI}/`;
const ep = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN, "--ui-port", String(UI)],
  { stdio: ["ignore", "pipe", "pipe"] });
const serverLog = [];
child.stderr.on("data", (d) => {
  for (const line of d.toString().split("\n")) if (line.trim()) serverLog.push(line.trim());
});

/** Drive the bridge the way a remote MCP client does. Returns the raw tool text. */
async function call(name, args, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ep, {
      method: "POST", signal: ac.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + TOKEN,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.text();
    let msg = null;
    for (const line of body.split("\n")) {
      if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5).trim()); } catch {} }
    }
    if (!msg) { try { msg = JSON.parse(body); } catch {} }
    if (!msg?.result) return { http: res.status, isError: true, text: body.slice(0, 200) };
    return {
      http: res.status,
      isError: !!msg.result.isError,
      text: (msg.result.content ?? []).map((c) => c.text ?? "").join(""),
    };
  } finally { clearTimeout(t); }
}
const asJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

try {
  await sleep(2500);

  console.log("\n" + "=".repeat(68));
  console.log("  OPEN THIS IN YOUR BROWSER:   " + uiUrl);
  console.log("=".repeat(68) + "\n");

  const read = await call("read", { path: "sample.txt" }, 20000);
  if (read.isError) throw new Error("read failed: " + read.text);
  console.log("step 1  read sample.txt   -> " + JSON.stringify(read.text.trim()));

  const say = await call("human_say", {
    text: "【验收 1/2】我是远端 agent。这条消息应该出现在你的浏览器里。",
    kind: "progress",
  }, 20000);
  if (say.isError || asJson(say.text)?.ok !== true) throw new Error("human_say failed: " + say.text);
  console.log("step 2  human_say         -> delivered (look at your browser)");

  if (autoDelay) {
    setTimeout(() => {
      fetch(uiUrl + "say", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "自动应答：我看到了" }),
      }).catch(() => {});
    }, autoDelay);
  }

  console.log("step 3  human_ask         -> WAITING FOR YOU. Type in the browser, press Enter.");
  const ask = await call("human_ask", {
    text: "【验收 2/2】请在这页的输入框里回一句话，然后按 Enter。",
    max_block_ms: 600000,
  }, 620000);

  const answer = asJson(ask.text);
  if (answer?.status === "human_message") {
    console.log("step 4  your reply        -> " + JSON.stringify(answer.text));
    console.log("\n  PASS — the tool call came back with your words: \"" + answer.text + "\"\n");
  } else {
    console.log("step 4  -> " + ask.text);
    console.log("\n  FAIL — no reply arrived from " + uiUrl + "\n");
    process.exitCode = 1;
  }
} catch (e) {
  console.error("\n  acceptance error: " + e.message + "\n");
  process.exitCode = 1;
} finally {
  if (process.exitCode) console.error(serverLog.join("\n"));
  child.kill();
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
}
