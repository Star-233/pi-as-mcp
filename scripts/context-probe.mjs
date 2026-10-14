/**
 * The context probe: project instructions (AGENTS.md / CLAUDE.md), asserted.
 *
 * Part one checks discovery: the global file, the walk from the working root up
 * to the git root and no further, AGENTS.md winning over CLAUDE.md in one
 * directory, the size cut, and the notice for an edited file. Part two starts
 * the bridge with HOME pointed at a temp dir and checks that the instructions
 * carry the files, and that an edit reaches the agent once as a notice and then
 * through get_instructions.
 *
 * The temp tree lives under the OS temp dir. Its repository is a directory with
 * a .git inside, so the walk stops there whatever sits above it.
 *
 * Usage: node scripts/context-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectContext, CONTEXT_MAX_BYTES } from "../src/context-files.ts";
import { ToolChangeTracker } from "../src/tool-watch.ts";

const repo = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-probe-"));
const home = path.join(base, "home");
const globalDir = path.join(home, ".pimcp");
const PORT = 18792;
const TOKEN = "context-probe-token";

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
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

// ---------------------------------------------------------------- part one
write(path.join(globalDir, "AGENTS.md"), "global rules");
write(path.join(base, "AGENTS.md"), "outside rules"); // above the repository: must not be read
fs.mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
write(path.join(base, "repo", "AGENTS.md"), "repo rules");
write(path.join(base, "repo", "sub", "CLAUDE.md"), "sub claude rules");
write(path.join(base, "repo", "sub", "deep", "AGENTS.md"), "deep rules");
write(path.join(base, "repo", "sub", "deep", "CLAUDE.md"), "ignored claude rules");
write(path.join(base, "big", "AGENTS.md"), "a".repeat(CONTEXT_MAX_BYTES + 5000));

{
  const got = loadProjectContext(path.join(base, "repo", "sub", "deep"), globalDir);
  const contents = got.map((f) => f.content);
  const want = ["global rules", "repo rules", "sub claude rules", "deep rules"];
  check("reads the global file, then the git root down to the working root", JSON.stringify(contents) === JSON.stringify(want), JSON.stringify(contents));
  check("AGENTS.md wins over CLAUDE.md in the same directory", !contents.includes("ignored claude rules"));
  check("the walk stops at the git root", !contents.includes("outside rules"));

  const big = loadProjectContext(path.join(base, "big"), globalDir).find((f) => f.path === path.join(base, "big", "AGENTS.md"));
  check("a very large file is cut and marked", !!big && big.truncated && Buffer.byteLength(big.content) <= CONTEXT_MAX_BYTES, big ? `${Buffer.byteLength(big.content)} bytes` : "not found");
}
{
  const t = new ToolChangeTracker();
  t.served([], [{ path: "x", hash: "1" }]);
  check("no notice while instructions are unchanged", t.takeNotice([], [{ path: "x", hash: "1" }]) === undefined);
  const n = t.takeNotice([], [{ path: "x", hash: "2" }]);
  check("an edited instructions file is announced", !!n && n.includes("~ project instructions: x changed"), String(n));
  check("the same edit is announced once", t.takeNotice([], [{ path: "x", hash: "2" }]) === undefined);
}

// ---------------------------------------------------------------- part two
const root = path.join(base, "repo", "sub", "deep");
const logs = [];
const child = spawn(process.execPath, ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN], {
  cwd: repo,
  env: { ...process.env, HOME: home, USERPROFILE: home },
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

try {
  await waitFor(() => new Promise((ok, no) => {
    const s = connect(PORT, "127.0.0.1", () => { s.end(); ok(true); });
    s.on("error", () => no(new Error("not yet")));
  }), 20000, "the bridge to listen");

  await rpc("tools/list"); // the agent is shown the list, so the instructions are the baseline
  const first = textOf(await call("get_instructions"));
  check("the instructions carry the global file", first.includes("global rules"));
  check("the instructions carry the repository file", first.includes("repo rules"));
  check("the instructions carry the working-root file", first.includes("deep rules"));

  write(path.join(root, "AGENTS.md"), "deep rules v2");
  const changed = await call("get_instructions");
  check("an edited file is announced in the next result", textOf(changed).includes("~ project instructions:") && textOf(changed).includes("[bridge notice]"), textOf(changed).slice(0, 200));
  check("get_instructions returns the new text", textOf(changed).includes("deep rules v2"));
  check("the edit is announced once", !textOf(await call("get_instructions")).includes("[bridge notice]"));
} catch (err) {
  failures++;
  console.log(`FAIL bridge run - ${err.message}`);
  console.log(logs.join("").slice(-1500));
} finally {
  // Wait for the bridge to exit before removing its files.
  // "close" fires after the exit and after the pipes are closed, so exiting
  // the process right after is safe on Windows.
  await new Promise((resolve) => {
    child.once("close", resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
  fs.rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall context checks passed" : `\n${failures} check(s) failed`);
// Let the event loop drain instead of calling process.exit: exiting while the
// bridge's stdio is closing trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
