/**
 * The controls probe: config file, sandbox root switch, upstream MCP servers,
 * and the web UI's /ctl endpoints, asserted.
 *
 * Part one exercises the units directly (the config loader, the sandbox's
 * setRoot, the aggregator against the mini fixture). Part two starts the real
 * bridge and drives it exactly the way the sidebar does - the same POSTs to the
 * same endpoints - then checks the effects over real MCP traffic, plus the file
 * write-back and the hot-reload watcher.
 *
 * Usage: node scripts/controls-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const tmp = path.join(repo, ".tmp-controls");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "rootA"), { recursive: true });
fs.mkdirSync(path.join(tmp, "rootB"), { recursive: true });
fs.writeFileSync(path.join(tmp, "rootA", "a.txt"), "from A\n");
fs.writeFileSync(path.join(tmp, "rootB", "b.txt"), "from B\n");

const configFile = path.join(tmp, "config.json");
// Before any import: the loaders read this env var at call time, and the bridge
// below inherits it, so every load here is isolated from the developer's own
// ~/.pimcp/config.json.
process.env.PI_AS_MCP_CONFIG = configFile;

const { loadConfig } = await import("../src/config.ts");
const { Sandbox } = await import("../src/sandbox.ts");
const { McpAggregator } = await import("../src/attach-mcp.ts");

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log((ok ? "ok    " : "FAIL  ") + label + (ok ? "" : "  (" + (detail ?? "") + ")"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("--- config file");
fs.writeFileSync(configFile, JSON.stringify({
  human: true,
  approval: { mode: "always" },
  mcps: { demo: { type: "http", url: "http://127.0.0.1:1/mcp" } },
}));
const c1 = loadConfig([]);
check("file sets the human channel", c1.human === true);
check("file sets approval always", c1.approvalMode === "always");
check("file carries upstreams", c1.mcps?.demo?.url === "http://127.0.0.1:1/mcp");
const c2 = loadConfig(["--no-human"]);
check("an explicit flag beats the file", c2.human === false, JSON.stringify(c2.human));
const c3 = loadConfig(["--approve"]);
check("--approve now means approval always", c3.approvalMode === "always");
const c3b = loadConfig(["--no-approve"]);
check("--no-approve keeps the file's word", c3b.approvalMode === "always");
fs.writeFileSync(configFile, "{ not json");
const c4 = loadConfig([]);
check("a broken file is ignored, not fatal", c4.human === false && c4.approvalMode === "never");

console.log("--- sandbox root switch");
const sb = new Sandbox(path.join(tmp, "rootA"), []);
check("resolves inside the root", sb.resolve("a.txt") === path.join(tmp, "rootA", "a.txt"));
let escaped = false;
try { sb.resolve("../rootB/b.txt"); } catch { escaped = true; }
check("escape refused", escaped);
sb.setRoot(path.join(tmp, "rootB"));
check("after the move, resolve follows the new root", sb.resolve("b.txt") === path.join(tmp, "rootB", "b.txt"));
let escapedAgain = false;
try { sb.resolve("../rootA/a.txt"); } catch { escapedAgain = true; }
check("the old root is out of bounds after the move", escapedAgain);
let missing = false;
try { sb.setRoot(path.join(tmp, "nope")); } catch { missing = true; }
check("a missing directory is refused", missing);
let notDir = false;
try { sb.setRoot(path.join(tmp, "rootB", "b.txt")); } catch { notDir = true; }
check("a file is not a root", notDir);

console.log("--- aggregator (real stdio upstream)");
const fixture = path.join(repo, "scripts", "fixtures", "mini-mcp-server.mjs");
const agg = new McpAggregator({
  // Stands in for the bridge's own tool names. The fixture's "path" tool, on an
  // upstream called "read", prefixes to "read_path" - exactly the shape a
  // collision takes, so that is the name this reserved set refuses.
  reserved: (n) => n === "read_path",
  log: () => {},
});
const up = await agg.connect("mini", { type: "stdio", command: process.execPath, args: [fixture] }, { fromConfig: false, enabled: true });
check("stdio upstream connects", up.ok, up.error);
check("tools are prefixed with the upstream's name", agg.tools().some((t) => t.name === "mini_echo"));
const echo = await agg.call("mini_echo", { text: "hello" });
check("a call is forwarded verbatim", echo.content[0]?.text === "echo: hello" && !echo.isError, JSON.stringify(echo.content));
const badTool = await agg.call("mini_nope", {});
check("an unknown upstream tool is an error, not a crash", badTool.isError === true);
const dead = await agg.connect("dead", { type: "http", url: "http://127.0.0.1:9/mcp" }, { fromConfig: false, enabled: true });
check("a dead http upstream is an error, not a crash", dead.ok === false);
check("the live upstream survived the dead one", agg.has("mini_echo"));
const readUp = await agg.connect("read", { type: "stdio", command: process.execPath, args: [fixture] }, { fromConfig: false, enabled: true });
check("a colliding upstream still connects", readUp.ok, readUp.error);
const names = agg.tools().map((t) => t.name);
check("a tool that would shadow a reserved name is skipped", !names.includes("read_path"), names.join(","));
check("its sibling survives", names.includes("read_echo"), names.join(","));
await agg.disconnect("mini");
check("disconnect removes the tools", !agg.has("mini_echo"));
await agg.closeAll();

console.log("--- the running bridge, driven like the sidebar");
fs.writeFileSync(configFile, JSON.stringify({
  human: true,
  approval: { mode: "never" },
  mcps: { mini: { type: "stdio", command: process.execPath, args: [fixture] } },
}, null, 2));

const PORT = 8811, UI = 8812, TOKEN = "controls-probe-token";
const child = spawn(process.execPath,
  ["src/index.ts", "--root", path.join(tmp, "rootA"), "--http", "--port", String(PORT),
   "--token", TOKEN, "--ui-port", String(UI), "--ui-token", TOKEN, "--human"],
  { stdio: ["ignore", "pipe", "pipe"], cwd: repo, env: { ...process.env } });
const logs = [];
child.stderr.on("data", (d) => logs.push(d.toString()));
child.stdout.on("data", (d) => logs.push(d.toString()));

async function waitForPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("the server exited early\n" + logs.join(""));
    const ok = await new Promise((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.on("error", () => resolve(false));
      sock.on("connect", () => { sock.destroy(); resolve(true); });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error("never listened\n" + logs.join(""));
}
await waitForPort(PORT);

const ep = `http://127.0.0.1:${PORT}/mcp`;
let nextId = 1;
async function mcp(method, params) {
  const res = await fetch(ep, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.text();
  let msg = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5).trim()); } catch {} }
  }
  if (!msg) { try { msg = JSON.parse(body); } catch {} }
  return { http: res.status, msg };
}
const firstText = (r) => r?.msg?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
async function uiPost(action, body) {
  const res = await fetch(`http://127.0.0.1:${UI}/ctl/${action}?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch {}
  return { status: res.status, body: j };
}
const say = (text) => fetch(`http://127.0.0.1:${UI}/say?token=${TOKEN}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
});
async function toolNames() {
  const list = await mcp("tools/list", {});
  return (list.msg?.result?.tools ?? []).map((t) => t.name);
}
async function until(fn, timeoutMs) {
  // fn is async, so its result must be awaited - a bare Promise is truthy and
  // would make every wait pass on its first tick.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(300);
  }
  return await fn();
}

try {
  // The upstream connects in the background; give it the same patience a user would.
  const upstreamUp = await until(async () => (await toolNames()).includes("mini_echo"), 30000);
  check("the configured upstream appears in tools/list", upstreamUp);
  const proxied = await mcp("tools/call", { name: "mini_echo", arguments: { text: "hi" } });
  check("a proxied call crosses the bridge", firstText(proxied) === "echo: hi", firstText(proxied));

  // Root switch, exactly the sidebar's POST.
  const moved = await uiPost("root", { path: path.join(tmp, "rootB") });
  check("moving the root via the UI", moved.status === 200 && moved.body?.ok === true, JSON.stringify(moved.body));
  const readB = await mcp("tools/call", { name: "read", arguments: { path: "b.txt" } });
  check("a read resolves in the new root", firstText(readB) === "from B\n", JSON.stringify(firstText(readB)));
  const oldRoot = await mcp("tools/call", { name: "read", arguments: { path: "../rootA/a.txt" } });
  check("the old root is out of bounds after the move", Boolean(oldRoot.msg?.result?.isError));
  const badRoot = await uiPost("root", { path: path.join(tmp, "nope") });
  check("a missing directory is refused, not fatal", badRoot.status === 400 && badRoot.body?.ok === false, JSON.stringify(badRoot.body));

  // Approval mode: never -> always, and the impossible combination refused.
  const humanOff = await uiPost("human", { enabled: false });
  check("the channel can be turned off while approval is never", humanOff.status === 200, JSON.stringify(humanOff.body));
  const alwaysRefused = await uiPost("approval", { mode: "always" });
  check("approval always without the channel is refused", alwaysRefused.status === 400, JSON.stringify(alwaysRefused.body));
  await uiPost("human", { enabled: true });
  const always = await uiPost("approval", { mode: "always" });
  check("approval always with the channel is accepted", always.status === 200, JSON.stringify(always.body));
  const gated = mcp("tools/call", { name: "bash", arguments: { command: "echo gated-ok" } });
  await sleep(700);
  await say("yes");
  const gatedDone = await gated;
  check("a gated call runs once approved", firstText(gatedDone).includes("gated-ok"), JSON.stringify(firstText(gatedDone)));
  const humanOffRefused = await uiPost("human", { enabled: false });
  check("the channel cannot be turned off while approval is always", humanOffRefused.status === 400, JSON.stringify(humanOffRefused.body));
  await uiPost("approval", { mode: "never" });
  const humanOff2 = await uiPost("human", { enabled: false });
  check("the channel turns off once approval is back to never", humanOff2.status === 200, JSON.stringify(humanOff2.body));

  // Upstream toggle from the UI.
  await uiPost("mcp-disconnect", { name: "mini" });
  const gone = await until(async () => !(await toolNames()).includes("mini_echo"), 15000);
  check("disconnect removes the upstream's tools", gone);
  const deadCall = await mcp("tools/call", { name: "mini_echo", arguments: { text: "x" } });
  check("a disconnected upstream's tool is unknown", Boolean(deadCall.msg?.result?.isError));
  await uiPost("mcp-connect", { name: "mini" });
  const back = await until(async () => (await toolNames()).includes("mini_echo"), 15000);
  check("reconnect brings the tools back", back);

  // Write-back: the UI actions must have landed in the config file.
  const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
  check("write-back: approval mode saved", saved.approval?.mode === "never", JSON.stringify(saved.approval));
  check("write-back: channel state saved", saved.human === false, JSON.stringify(saved.human));
  check("write-back: the reconnected upstream is enabled",
    saved.mcps?.mini?.enabled === true && saved.mcps?.mini?.command,
    JSON.stringify(saved.mcps));

  // Hot reload: an editor's write, not a UI action.
  const hot = JSON.parse(fs.readFileSync(configFile, "utf8"));
  hot.human = true;
  fs.writeFileSync(configFile, JSON.stringify(hot, null, 2));
  const hotApplied = await until(async () => {
    const info = await (await fetch(`http://127.0.0.1:${UI}/info?token=${TOKEN}`)).json();
    return info.human === true;
  }, 10000);
  check("a hand edit to the file applies without a restart", hotApplied);
} catch (e) {
  console.error("PROBE FAILED:", e.message);
  failures++;
} finally {
  child.kill();
  await sleep(300);
}

console.log(failures ? `\n${failures} control check(s) FAILED` : "\nall control checks passed");
if (failures) {
  console.error(logs.join(""));
  process.exit(1);
}
