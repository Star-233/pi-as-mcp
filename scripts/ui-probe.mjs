/**
 * Drives the real server and checks the human web UI's surface end to end: the
 * page, the vendored assets, /info, /health, and the SSE stream that now carries
 * tool-call entries, their completion patches, and the wait-window deadline.
 *
 * Unlike the other probes this one asserts: any failure exits non-zero, so
 * `npm test` catches a UI regression instead of printing a line to skim.
 *
 * Usage: node scripts/ui-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".tmp-ui");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");

const PORT = 8800, UI = 8793, TOKEN = "ui-probe-token-0xDEADBEEF";
const child = spawn(process.execPath,
  ["src/index.ts", "--root", root, "--http", "--port", String(PORT), "--token", TOKEN,
   "--ui-port", String(UI), "--ui-token", TOKEN, "--human"],
  { stdio: ["ignore", "pipe", "pipe"] });
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

const ui = (p) => `http://127.0.0.1:${UI}${p}${p.includes("?") ? "&" : "?"}token=${TOKEN}`;
const ep = `http://127.0.0.1:${PORT}/mcp`;
let id = 1;
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function mcp(method, params) {
  const res = await fetch(ep, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const body = await res.text();
  let msg = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) { try { msg = JSON.parse(line.slice(5).trim()); } catch { /* keep last */ } }
  }
  if (!msg) { try { msg = JSON.parse(body); } catch { /* not json */ } }
  return { http: res.status, msg };
}
const firstText = (r) => r?.msg?.result?.content?.map((c) => c.text ?? "").join("") ?? "";

/**
 * Read one SSE frame and hang up. /events never closes, so `.text()` on it would
 * block forever - which is exactly how the first version of this probe hung.
 */
async function firstFrame(u) {
  const ctrl = new AbortController();
  const res = await fetch(u, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const i = buf.indexOf("\n\n");
    if (i !== -1) {
      ctrl.abort();
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
      return line ? JSON.parse(line.slice(5).trim()) : null;
    }
  }
  ctrl.abort();
  return null;
}

/** Collect SSE frames from /events in the background until stopped. */
async function collectEvents() {
  const frames = [];
  const ctrl = new AbortController();
  const pump = (async () => {
    const res = await fetch(ui("/events"), { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (line) { try { frames.push(JSON.parse(line.slice(5).trim())); } catch { /* partial */ } }
      }
    }
  })().catch(() => {});
  await sleep(300);
  return { frames, stop: () => { ctrl.abort(); return pump; } };
}

// A probe that hangs is worse than one that fails: nothing would ever report it.
const watchdog = setTimeout(() => {
  console.error("PROBE TIMED OUT after 90s");
  child.kill();
  process.exit(1);
}, 90000);
watchdog.unref?.();

try {
  // ---- the page and its vendored assets -----------------------------------
  const page = await fetch(ui("/"));
  const html = await page.text();
  check("GET / serves the page", page.status === 200 && html.includes("human channel"));
  check("page is served no-store", String(page.headers.get("cache-control")).includes("no-store"),
    String(page.headers.get("cache-control")));
  check("page loads vendored marked", html.includes('src="vendor/marked.umd.js"'));
  check("page loads vendored katex", html.includes('src="vendor/katex.min.js"') && html.includes('href="vendor/katex.min.css"'));
  check("page has the info panel", html.includes('id="side"') && html.includes("/info"));

  for (const [p, type, min] of [
    ["/vendor/marked.umd.js", "text/javascript", 30000],
    ["/vendor/katex.min.js", "text/javascript", 100000],
    ["/vendor/katex.min.css", "text/css", 20000],
    ["/vendor/fonts/KaTeX_Main-Regular.woff2", "font/woff2", 5000],
  ]) {
    const r = await fetch(ui(p));
    const len = Number(r.headers.get("content-length") || 0);
    check(`GET ${p}`, r.status === 200 && String(r.headers.get("content-type")).startsWith(type) && len > min,
      `${r.status} ${r.headers.get("content-type")} ${len}B`);
  }

  // The page is re-read per request, so a styling tweak needs a refresh, not a
  // restart of the bridge. This edits the real ui.html and puts it back in a
  // finally; only a hard kill mid-test could leave the marker behind, and git
  // status would show it.
  const pagePath = path.resolve("src/human/ui.html");
  const pageBefore = fs.readFileSync(pagePath, "utf8");
  try {
    fs.writeFileSync(pagePath, pageBefore + "\n<!-- ui-probe hot reload marker -->\n");
    const edited = await (await fetch(ui("/"))).text();
    check("page is re-read on every request", edited.includes("ui-probe hot reload marker"));
  } finally {
    fs.writeFileSync(pagePath, pageBefore);
  }
  const afterEdit = await (await fetch(ui("/"))).text();
  check("and the restore is picked up too", !afterEdit.includes("ui-probe hot reload marker"));

  // Only the encoded forms reach the handler: the URL parser normalises a literal
  // `/vendor/../index.ts` to `/index.ts` before it gets here, which then 404s.
  for (const p of ["/vendor/..%2Findex.ts", "/vendor/%2e%2e%2fpackage.json", "/vendor/..%5C..%5Cpackage.json"]) {
    const escaped = await fetch(ui(p));
    // %5C is a backslash: a separator on Windows, an ordinary filename character
    // elsewhere. Either way nothing outside vendor/ may be served, but the code
    // differs - 403 for an escaped path, 404 for a file that cannot exist.
    check(`traversal blocked: ${p}`,
      escaped.status === 403 || escaped.status === 404,
      `got ${escaped.status}`);
  }
  const missing = await fetch(ui("/vendor/nope.js"));
  check("missing vendor file 404s", missing.status === 404, `got ${missing.status}`);
  const noAuth = await fetch(`http://127.0.0.1:${UI}/info`);
  check("info requires the ui token", noAuth.status === 401, `got ${noAuth.status}`);

  // ---- /info ---------------------------------------------------------------
  const info = await (await fetch(ui("/info"))).json();
  check("info exposes the sandbox root", info.root === root, info.root);
  check("info lists the tools",
    Array.isArray(info.tools) && info.tools.length === (process.platform === "win32" ? 8 : 7),
    String(info.tools?.length));
  check("info lists the deny list", Array.isArray(info.deny) && info.deny.length === 6);
  check("info reports the wait window", info.blockMs === 90000, String(info.blockMs));
  check("info reports tokens as set, never as values",
    info.httpTokenSet === true && info.uiTokenSet === true && !JSON.stringify(info).includes(TOKEN));
  check("info reports the mcp endpoint", info.endpoint === `${ep}`, info.endpoint);
  check("info carries the channel snapshot", typeof info.channel?.startedAt === "number");

  // ---- /health -------------------------------------------------------------
  const health = await (await fetch(ui("/health"))).json();
  check("health reports waiting/deadline/entries/startedAt",
    health.ok === true && health.waiting === null && health.deadline === null &&
    typeof health.entries === "number" && typeof health.startedAt === "number",
    JSON.stringify(health));

  // ---- the SSE stream, live ------------------------------------------------
  const ev = await collectEvents();
  const history = ev.frames.find((f) => f.type === "history");
  check("stream opens with a history frame", Boolean(history) && Array.isArray(history.entries));
  check("history frame carries waiting + deadline", history && "waiting" in history && "deadline" in history);

  // a tool call must show up as a `tool` entry, then get patched with its outcome
  const ran = await mcp("tools/call", { name: "bash", arguments: { command: "echo probe-ui-ok" } });
  check("bash tool call succeeded", !ran.msg?.result?.isError, firstText(ran).trim());

  const failed = await mcp("tools/call", { name: "read", arguments: { path: "../../outside.txt" } });
  check("sandbox escape is a tool error", failed.msg?.result?.isError === true, firstText(failed).slice(0, 50));

  await mcp("tools/call", { name: "human_say", arguments: { text: "**bold** and $E=mc^2$", kind: "note" } });
  await sleep(400);

  const toolFrames = ev.frames.filter((f) => f.type === "entry" && f.entry.role === "tool");
  const bashEntry = toolFrames.find((f) => f.entry.tool === "bash");
  check("tool call streamed as a tool entry", Boolean(bashEntry), `${toolFrames.length} tool frames`);
  check("tool entry starts as running", bashEntry?.entry.status === "running", bashEntry?.entry.status);
  check("tool entry carries the command", bashEntry?.entry.text === "echo probe-ui-ok", bashEntry?.entry.text);

  const patches = ev.frames.filter((f) => f.type === "entry_update");
  const bashPatch = patches.find((f) => f.id === bashEntry?.entry.id);
  check("tool completion streamed as entry_update", Boolean(bashPatch));
  check("patch records ok + duration", bashPatch?.patch?.status === "ok" && typeof bashPatch?.patch?.ms === "number",
    JSON.stringify(bashPatch?.patch));
  check("patch carries an output preview", String(bashPatch?.patch?.detail ?? "").includes("probe-ui-ok"),
    JSON.stringify(bashPatch?.patch?.detail));

  const errPatch = patches.find((f) => f.id === toolFrames.find((t) => t.entry.tool === "read")?.entry.id);
  check("failed tool is recorded as error", errPatch?.patch?.status === "error", JSON.stringify(errPatch?.patch));

  const sayEntry = ev.frames.find((f) => f.type === "entry" && f.entry.kind === "note");
  check("human_say streams with its kind", sayEntry?.entry.role === "agent" && sayEntry?.entry.text.includes("E=mc^2"));

  // replay after everything: the patched state must be in history, not just live
  const replayed = await firstFrame(ui("/events"));
  check("reconnect replays history", replayed?.type === "history");
  const replayBash = replayed.entries.find((e) => e.tool === "bash");
  check("replay holds the final tool state", replayBash?.status === "ok" && typeof replayBash?.ms === "number",
    JSON.stringify(replayBash));
  check("replay holds both roles and tools",
    replayed.entries.some((e) => e.role === "agent") && replayed.entries.some((e) => e.role === "tool"));

  // ---- the wait window exposes a deadline ---------------------------------
  const askP = mcp("tools/call", { name: "human_ask", arguments: { text: "ping?", max_block_ms: 20000 } });
  await sleep(600);
  const mid = await (await fetch(ui("/health"))).json();
  check("health shows the ask in flight", mid.waiting === "ask", mid.waiting);
  check("health exposes a future deadline", typeof mid.deadline === "number" && mid.deadline > Date.now(),
    String(mid.deadline));
  const stateAsk = ev.frames.filter((f) => f.type === "state").pop();
  check("state frame carries the deadline", typeof stateAsk?.deadline === "number" && stateAsk.waiting === "ask",
    JSON.stringify(stateAsk));

  await fetch(`http://127.0.0.1:${UI}/say?token=${TOKEN}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "pong" }),
  });
  const ask = await askP;
  check("human_ask round-trips through the ui", firstText(ask).includes("pong"), firstText(ask).replace(/\s+/g, " "));
  await sleep(300);
  const after = await (await fetch(ui("/health"))).json();
  check("deadline clears once answered", after.waiting === null && after.deadline === null, JSON.stringify(after));

  await ev.stop();
} catch (e) {
  failures++;
  console.error("PROBE THREW:", e.message);
  console.error(logs.join("").trim());
} finally {
  clearTimeout(watchdog);
  child.kill();
  await sleep(200);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall ui checks passed");
process.exit(failures ? 1 : 0);
