/**
 * The confine probe: the file tools are held to the sandbox root and the deny
 * list by default, and "confine": false in the config file lifts both while the
 * bridge runs. bash and powershell are not confined either way.
 *
 * Part one checks the Sandbox class directly. Part two starts the bridge with
 * HOME and the config file in a temp dir, and checks the file tools before and
 * after the setting changes. Only files inside the temp tree are read or written.
 *
 * Usage: node scripts/confine-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox, SandboxError } from "../src/sandbox.ts";

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

// The temp tree is made by mkdtemp, and only that directory is removed.
const repo = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "confine-probe-"));
const home = path.join(base, "home");
const work = path.join(base, "work");
const configFile = path.join(base, "config.json");
const PORT = 18795;
const TOKEN = "confine-probe-token";

fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(work, ".ssh"), { recursive: true });
fs.writeFileSync(path.join(base, "outside.txt"), "OUTSIDE-MARKER\n");
fs.writeFileSync(path.join(work, ".ssh", "id_test"), "DENY-MARKER\n");

// ---------------------------------------------------------------- part one
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof SandboxError;
  }
};
const sb = new Sandbox(work, [".ssh"]);
check("the sandbox is confined by default", sb.confined === true);
check("a confined path cannot leave the root", refuses(() => sb.resolve("../outside.txt")));
check("a confined deny-listed path is refused", refuses(() => sb.resolve(".ssh/id_test")));
sb.setConfined(false);
check("unconfined, a path outside the root resolves",
  sb.resolve("../outside.txt") === path.resolve(work, "../outside.txt"));
check("unconfined, a deny-listed path resolves",
  sb.resolve(".ssh/id_test") === path.resolve(work, ".ssh/id_test"));
sb.setConfined(true);
check("confining again restores the refusal", refuses(() => sb.resolve("../outside.txt")));
const open = new Sandbox(work, [".ssh"], false);
check("a sandbox built unconfined starts unconfined",
  open.confined === false && open.resolve("../outside.txt") === path.resolve(work, "../outside.txt"));

// ---------------------------------------------------------------- part two
// The file exists from the start, so the bridge watches it for the change.
fs.writeFileSync(configFile, "{}\n");
const logs = [];
const child = spawn(process.execPath, ["src/index.ts", "--root", work, "--http", "--port", String(PORT), "--token", TOKEN], {
  cwd: repo,
  env: { ...process.env, HOME: home, USERPROFILE: home, PI_AS_MCP_CONFIG: configFile },
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
const readOutside = () => call("read", { path: "../outside.txt" });
const readDenied = () => call("read", { path: ".ssh/id_test" });

try {
  await waitFor(() => new Promise((ok, no) => {
    const s = connect(PORT, "127.0.0.1", () => { s.end(); ok(true); });
    s.on("error", () => no(new Error("not yet")));
  }), 20000, "the bridge to listen");
  await rpc("tools/list");

  const refusedOutside = await readOutside();
  check("by default a file tool cannot read outside the root",
    refusedOutside.result?.isError === true && textOf(refusedOutside).includes("escapes the sandbox root"), textOf(refusedOutside).slice(0, 200));
  const refusedDenied = await readDenied();
  check("by default a file tool cannot read the deny list",
    refusedDenied.result?.isError === true && textOf(refusedDenied).includes("deny list"), textOf(refusedDenied).slice(0, 200));

  // The human sets full access in the config file; the bridge picks it up while running.
  fs.writeFileSync(configFile, JSON.stringify({ confine: false }) + "\n");
  const unconfined = await waitFor(async () => {
    const r = await readOutside();
    return !r.result?.isError && textOf(r).includes("OUTSIDE-MARKER");
  }, 20000, "the bridge to unconfine the file tools");
  check("with confine false the file tools read outside the root", unconfined === true);

  const deniedNow = await readDenied();
  check("with confine false the file tools read the deny list too",
    !deniedNow.result?.isError && textOf(deniedNow).includes("DENY-MARKER"), textOf(deniedNow).slice(0, 200));
  const wrote = await call("write", { path: "../written-outside.txt", content: "W-MARKER\n" });
  check("with confine false write reaches outside the root",
    !wrote.result?.isError && fs.readFileSync(path.join(base, "written-outside.txt"), "utf8") === "W-MARKER\n", textOf(wrote).slice(0, 200));
  check("the switch is logged once", logs.join("").includes("file tools are not confined") || logs.join("").includes("config (hot): file tools not confined"));

  // Back to confined: the refusal returns without a restart.
  fs.writeFileSync(configFile, JSON.stringify({ confine: true }) + "\n");
  const reconfined = await waitFor(async () => {
    const r = await readOutside();
    return r.result?.isError === true && textOf(r).includes("escapes the sandbox root");
  }, 20000, "the bridge to confine the file tools again");
  check("setting confine back to true re-confines the file tools", reconfined === true);
} catch (err) {
  failures++;
  console.log(`FAIL bridge run - ${err.message}`);
  console.log(logs.join("").slice(-1500));
} finally {
  // "close" fires after the exit and after the pipes are closed.
  await new Promise((resolve) => {
    child.once("close", resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall confine checks passed" : `\n${failures} confine check(s) failed`);
// Let the event loop drain instead of calling process.exit: exiting while the
// bridge's stdio is closing trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
