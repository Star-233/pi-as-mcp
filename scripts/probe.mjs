import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".tmp-test");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
fs.writeFileSync(path.join(root, "hello.txt"), "line1\nline2\nline3\n");
fs.writeFileSync(path.join(root, "sub", "nested.txt"), "nested\n");

const child = spawn(
  process.execPath,
  ["src/index.ts", "--root", root, "--ui-port", "8791", "--human"],
  { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_AS_MCP_CONFIG: path.resolve(".tmp-probe-config", "none.json") } },
);

let buf = "";
const pending = new Map();
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout: " + method)); } }, 60000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const firstText = (res) => res?.result?.content?.map((c) => c.text ?? "").join("");

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" },
  });
  const instr = init.result.instructions ?? "";
  console.log("1) initialize ->", init.result.serverInfo.name, "| instructions:", instr.length, "chars");
  console.log("   prompt sections:", (instr.match(/<([a-z_]+)>/g) || []).join(" "));

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  console.log("2) tools/list ->", names.length, "tools:", names.join(", "));
  const readTool = list.result.tools.find((t) => t.name === "read");
  console.log("   read schema is JSON-Schema:", JSON.stringify(readTool.inputSchema).slice(0, 90));

  const read = await call("read", { path: "hello.txt" });
  console.log("3) read hello.txt ->", JSON.stringify(firstText(read)).slice(0, 120));

  const esc = await call("read", { path: "../../../Windows/win.ini" });
  const escText = esc.error ? JSON.stringify(esc.error) : firstText(esc);
  console.log("4) outside the root ->",
    /escapes the sandbox root/i.test(escText)
      ? "*** STILL REFUSED ***"
      : "reached the tool: " + escText.slice(0, 70).replace(/\s+/g, " "));

  const write = await call("write", { path: "sub/new.txt", content: "written by probe" });
  console.log("5) write ->", write.result.isError ? "ERR " + firstText(write) : firstText(write));
  console.log("   file on disk:", fs.readFileSync(path.join(root, "sub", "new.txt"), "utf8"));

  const bash = await call("bash", { command: "echo bash-works" });
  console.log("6) bash ->", bash.result.isError ? "ERR " + firstText(bash).slice(0, 80) : JSON.stringify(firstText(bash)).slice(0, 80));

  const say = await call("human_say", { text: "hello from the agent", kind: "progress" });
  console.log("7) human_say ->", firstText(say).replace(/\s+/g, " "));

  const askPromise = call("human_ask", { text: "Approve?" });
  await sleep(400);
  const post = await fetch("http://127.0.0.1:8791/say", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "yes go ahead" }),
  });
  const ask = await askPromise;
  console.log("8) human_ask round-trip ->", post.status, firstText(ask).replace(/\s+/g, " "));

  const waitPromise = call("human_wait", { reason: "idle", max_block_ms: 1500 });
  const wait = await waitPromise;
  console.log("9) human_wait timeout ->", firstText(wait).replace(/\s+/g, " "));

  const instrTool = await call("get_instructions", {});
  console.log("10) get_instructions ->", firstText(instrTool).length, "chars");

  console.log("\n--- server log ---");
  console.log(logs.join("").trim());
} catch (e) {
  console.error("PROBE FAILED:", e.message);
  console.error(logs.join("").trim());
} finally {
  child.kill();
}
