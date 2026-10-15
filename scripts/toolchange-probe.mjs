/**
 * The tool-change probe: an upstream whose tool list moves at runtime, seen
 * through a real bridge over HTTP.
 *
 * Part one checks the tracker alone. Part two starts the bridge with a config
 * file that attaches the mutating fixture, then checks that:
 *   1. the upstream's own tools/list_changed reaches the bridge's tool list;
 *   2. the agent is told about it once, on its next tool result;
 *   3. editing the config of a connected upstream reconnects it, and the
 *      removal is announced;
 *   4. a call to a tool whose upstream is down says so and points at
 *      get_instructions.
 *
 * Usage: node scripts/toolchange-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { ToolChangeTracker } from "../src/tool-watch.ts";

const repo = path.resolve(import.meta.dirname, "..");
const tmp = path.join(repo, ".tmp-toolchange");
const fixture = path.join(repo, "scripts", "fixtures", "mutating-mcp-server.mjs");
const configFile = path.join(tmp, "config.json");
const PORT = 18791;
const TOKEN = "toolchange-probe-token";
const INSTRUCTIONS = "get_instructions";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------- part one
{
  const t = new ToolChangeTracker();
  const a = [{ name: "x", description: "X", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];
  check("no notice before any list was served", t.takeNotice(a) === undefined);
  t.served(a);
  check("no notice when nothing moved", t.takeNotice(a) === undefined);
  const b = [...a, { name: "y", description: "Y\nsecond line", inputSchema: { type: "object", properties: {} } }];
  const n1 = t.takeNotice(b);
  check("an added tool is announced with its params", !!n1 && n1.includes("+ y: Y (params: none)"), String(n1));
  check("the same change is announced once", t.takeNotice(b) === undefined);
  const c = [{ name: "x", description: "X", inputSchema: { type: "object", properties: { q: { type: "number" } } } }];
  const n2 = t.takeNotice(c);
  check("a changed schema and a removal are announced", !!n2 && n2.includes("~ x:") && n2.includes("- y: removed"), String(n2));
}

// ---------------------------------------------------------------- part two
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "root"), { recursive: true });
const writeConfig = (mut) => fs.writeFileSync(configFile, JSON.stringify({ mcps: { mut: { type: "stdio", command: process.execPath, args: [fixture], ...mut } } }, null, 2));
writeConfig({ enabled: true });

const logs = [];
const child = spawn(process.execPath, ["src/index.ts", "--root", path.join(tmp, "root"), "--http", "--port", String(PORT), "--token", TOKEN, "--ui-port", "8805"], {
  cwd: repo,
  env: { ...process.env, PI_AS_MCP_CONFIG: configFile },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));

let nextId = 1;
async function rpc(method, params = {}) {
  const id = nextId++;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const msg = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === id);
  if (!msg) throw new Error(`no response to ${method}: ${text.slice(0, 200)}`);
  return msg;
}
const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const textOf = (msg) => (msg.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const listNames = async () => (await rpc("tools/list")).result.tools.map((t) => t.name);

try {
  await waitFor(() => new Promise((ok, no) => {
    const s = connect(PORT, "127.0.0.1", () => { s.end(); ok(true); });
    s.on("error", () => no(new Error("not yet")));
  }), 20000, "the bridge to listen");

  await waitFor(async () => (await listNames()).includes("mut_ping"), 20000, "the upstream to attach");
  const baseline = await listNames();
  check("upstream tools are listed", baseline.includes("mut_grow") && !baseline.includes("mut_later"), baseline.join(","));

  // 1 + 2: the upstream grows; the agent hears about it once.
  const grown = await call("mut_grow");
  await sleep(1500);
  const status = await call(INSTRUCTIONS);
  const notices = [grown, status].map(textOf).filter((t) => t.includes("[bridge notice]"));
  check("the growth is announced exactly once", notices.length === 1, `announcements: ${notices.length}`);
  check("the announcement names the new tool", notices.length === 1 && notices[0].includes("+ mut_later"), notices[0] ?? "none");
  check("get_instructions reports the upstream as connected", textOf(status).includes("mut: connected"));

  const ping = await call("mut_ping");
  check("a later call does not repeat the announcement", !textOf(ping).includes("[bridge notice]"));
  check("the upstream still answers", textOf(ping) === "pong", textOf(ping));

  // 3: a config edit reconnects the upstream; the removal is announced.
  writeConfig({ enabled: true, env: { MARK: "2" } });
  let removal = "";
  await waitFor(async () => {
    const t = textOf(await call(INSTRUCTIONS));
    if (t.includes("- mut_later: removed")) removal = t;
    return removal !== "";
  }, 20000, "the config edit to reconnect");
  check("a config edit reconnects, and the removal is announced", removal.includes("[bridge notice]"));

  // 4: the upstream goes down; calls say why.
  writeConfig({ enabled: false });
  await waitFor(async () => textOf(await call(INSTRUCTIONS)).includes("mut: disconnected"), 20000, "the upstream to disconnect");
  const down = await call("mut_ping");
  check("a call to a disconnected upstream is an error that says why", down.result?.isError === true && textOf(down).includes('upstream "mut" is disconnected'), textOf(down));
  check("the error points at get_instructions", textOf(down).includes("get_instructions"));
} catch (err) {
  failures++;
  console.log(`FAIL bridge run - ${err.message}`);
  console.log(logs.join("").slice(-1500));
} finally {
  child.kill();
}

console.log(failures === 0 ? "\nall toolchange checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
