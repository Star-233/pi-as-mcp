/**
 * Runs the human UI's own inline script in a real DOM (jsdom) and checks what it
 * actually renders. The server-side probe cannot see this, and the risky part of
 * the page lives here: agent messages are markdown from a remote model, so the
 * allowlist that decides which tags survive is a security boundary, not styling.
 *
 * It loads the *vendored* marked and katex, the same files the browser gets.
 *
 * Usage: node scripts/ui-render-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = (f) => path.join(here, "..", "src", "human", "vendor", f);

const html = fs.readFileSync(path.join(here, "..", "src", "human", "ui.html"), "utf8");
const inline = html.match(/<script>([\s\S]*?)<\/script>/);
if (!inline) {
  console.error("FAIL  could not find the inline script in ui.html");
  process.exit(1);
}
// Scripts come out of the shell and are eval'd by hand, in order, so the stubs are
// in place first and nothing runs twice.
const shell = html.replace(/<script[\s\S]*?<\/script>/g, "");

let failures = 0;
const notifyLog = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const INFO = {
  serverName: "pi-as-mcp", version: "0.1.0", root: "D:\\tmp\\root",
  tools: ["read", "bash"], approve: [], deny: [".ssh"], blockMs: 90000, human: true,
  transport: "http", endpoint: "http://127.0.0.1:8800/mcp",
  httpTokenSet: true, uiTokenSet: true, pid: 1, platform: "win32 x64", node: "v24.9.0",
  oauth: { enabled: false },
  channel: { waiting: null, deadline: null, entries: 0, startedAt: Date.now() },
};

const OAUTH_INFO = {
  ...INFO,
  oauth: { enabled: true, issuer: "https://bridge.example/", grants: { clients: 2, pending: 1, accessTokens: 3, refreshTokens: 2 } },
};

/**
 * Build a window with the page's script already running. `withLibs=false` proves the
 * page still works as plain text when the vendored files fail to load.
 */
async function boot(withLibs = true) {
  const dom = new JSDOM(shell, {
    url: "http://127.0.0.1:8793/?token=t",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const w = dom.window;
  w.alert = () => {};
  // Record what the page would have alerted on, to prove kinds still mean
  // something server-side even though they no longer mean anything visually.
  notifyLog.length = 0;
  // Every request the page makes, so a click can be checked against what it sent.
  const calls = [];
  w.fetch = async (u, init) => {
    calls.push({ url: String(u), init: init || {} });
    return {
      ok: true, status: 200,
      json: async () => (String(u).includes("/info") ? INFO : { ok: true, waiting: null, deadline: null, entries: 0, startedAt: Date.now() }),
      text: async () => "",
    };
  };
  const sources = [];
  w.EventSource = class {
    constructor(url) { this.url = url; this.readyState = 1; sources.push(this); }
    close() { this.readyState = 2; }
    push(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  };
  if (withLibs) {
    // eval, not require: the UMD wrappers need a browser-shaped realm (`this` is
    // undefined at the top level of an ESM module, and Node treats these files as
    // ESM). This is also literally what a <script src> does in the browser.
    w.eval(fs.readFileSync(vendor("marked.umd.js"), "utf8"));
    w.eval(fs.readFileSync(vendor("katex.min.js"), "utf8"));
  }
  w.eval(inline[1]);
  await new Promise((r) => setTimeout(r, 30));
  return { dom, w, es: sources[0], calls };
}

const at = Date.now();
const ENTRIES = [
  { id: "e1", role: "agent", kind: "message", at: at, text: "Hello **world** and `inline code`.\n\n- one\n- two" },
  { id: "e2", role: "agent", kind: "note", at: at + 1, text: "<script>window.__pwned=1</script><img src=x onerror=\"window.__pwned=1\">plain" },
  { id: "e3", role: "agent", kind: "note", at: at + 2, text: "[bad](javascript:window.__pwned=1) and [good](https://example.com)" },
  { id: "e4", role: "agent", kind: "note", at: at + 3, text: "```bash\nfor i in 1 2; do echo $i; done\n```" },
  { id: "e5", role: "agent", kind: "note", at: at + 4, text: "Inline $E=mc^2$ math.\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$\n\nCosts $5 and $10." },
  { id: "e6", role: "agent", kind: "done", at: at + 5, text: "finished" },
  { id: "e7", role: "agent", kind: "error", at: at + 6, text: "broke" },
  { id: "e8", role: "human", kind: "message", at: at + 7, text: "my own <b>text</b> stays literal" },
  { id: "e9", role: "tool", kind: "tool", at: at + 8, text: "echo hi", tool: "bash", status: "running" },
  { id: "e10", role: "agent", kind: "question", at: at + 9, text: "may I proceed?" },
];

// ---------------------------------------------------------------- with libs
{
  const { dom, w, es, calls } = await boot(true);
  const doc = w.document;
  // Kinds no longer reach the markup, but they must still drive the alerts - that
  // is the only remaining signal that the agent is blocked on you.
  w.chime = (kind) => notifyLog.push(kind);
  w.alerts = true;
  es.push({ type: "history", waiting: null, deadline: null, startedAt: at, entries: ENTRIES });
  await new Promise((r) => setTimeout(r, 50));

  check("marked is the vendored build", typeof w.marked?.parse === "function");
  check("katex is the vendored build", typeof w.katex?.render === "function");

  const body1 = doc.querySelector(".m.agent .md");
  check("markdown renders", Boolean(body1?.querySelector("strong")) && Boolean(body1?.querySelector("code")));
  check("markdown lists render", (body1?.querySelectorAll("li") ?? []).length === 2);

  const log = doc.getElementById("log");
  check("script tag stripped from agent html", log.querySelectorAll("script").length === 0);
  check("injected script did not run", w.__pwned === undefined);
  check("img stripped", log.querySelectorAll("img").length === 0);
  check("inline event handler cannot survive", !/\sonerror\s*=/i.test(log.innerHTML));
  check("surviving text is kept", log.textContent.includes("plain"));

  const badLink = [...log.querySelectorAll("a")].find((a) => (a.getAttribute("title") || a.textContent) === "bad");
  check("javascript: href removed", badLink && !badLink.hasAttribute("href"),
    badLink ? badLink.outerHTML.slice(0, 60) : "no anchor");
  const goodLink = [...log.querySelectorAll("a")].find((a) => a.textContent === "good");
  check("safe href kept with noopener", goodLink?.getAttribute("href") === "https://example.com"
    && goodLink?.getAttribute("rel") === "noopener noreferrer" && goodLink?.getAttribute("target") === "_blank");

  const box = log.querySelector(".codebox");
  check("code fence gets a box and a copy button", Boolean(box?.querySelector("pre code")) && Boolean(box?.querySelector(".copy")));
  check("code fence content is intact", box?.textContent.includes("for i in 1 2; do echo $i; done"));

  check("inline latex rendered", log.querySelectorAll(".katex").length >= 1, `${log.querySelectorAll(".katex").length} spans`);
  check("display latex rendered", log.querySelectorAll(".katex-display").length === 1);
  check("latex actually produced markup", Boolean(log.querySelector(".katex .mord")));
  check("plain $5 stays text", log.textContent.includes("$5 and $10"));
  const preInMath = [...log.querySelectorAll("pre")].some((p) => p.querySelector(".katex"));
  check("code blocks are not math-scanned", !preInMath);

  // A chat has one bubble shape. Kinds still travel in the data (the server sends
  // them and the alerts still key off them) but none of it reaches the markup.
  check("no kind badges are rendered", log.querySelectorAll(".badge").length === 0,
    `${log.querySelectorAll(".badge").length} badges`);
  const agentBubbles = [...log.querySelectorAll(".m.agent")];
  check("every agent bubble carries the same single class",
    agentBubbles.length >= 5 && agentBubbles.every((b) => b.className === "m agent"),
    [...new Set(agentBubbles.map((b) => b.className))].join(" | "));
  check("kinds still drive the alerts, not the styling",
    notifyLog.includes("question") && notifyLog.includes("done") && notifyLog.includes("error"),
    notifyLog.join(","));

  const mine = [...log.querySelectorAll(".m.human")].pop();
  check("human messages are not markdown-parsed", mine?.querySelectorAll("b").length === 0
    && mine?.textContent.includes("<b>text</b>"));

  const tool = log.querySelector(".tool");
  check("tool row renders", tool?.querySelector(".name")?.textContent === "bash"
    && tool?.querySelector(".args")?.textContent === "echo hi"
    && tool?.querySelector(".run")?.textContent === "⋯");

  es.push({ type: "entry_update", id: "e9", patch: { status: "ok", ms: 42, detail: "hi" } });
  check("tool row is patched in place", tool?.querySelector(".ms")?.textContent === "42 ms"
    && tool?.querySelector(".ok")?.textContent === "✓"
    && tool?.querySelector(".detail")?.textContent === "hi"
    && !tool.classList.contains("running"));
  tool.querySelector(".row").click();
  check("tool detail is expandable", tool.classList.contains("open"));
  check("expanded tool detail is actually visible",
    w.getComputedStyle(tool.querySelector(".detail")).display !== "none",
    "computed display: " + w.getComputedStyle(tool.querySelector(".detail")).display);

  check("tally counts every role",
    doc.getElementById("tally").textContent === "8 agent · 1 you · 1 tool calls",
    doc.getElementById("tally").textContent);

  // the info panel
  check("info panel shows the root", doc.getElementById("side").textContent.includes("D:\\tmp\\root"));
  check("info panel shows tool chips", [...doc.querySelectorAll("#side .chip")].some((c) => c.textContent === "bash"));
  check("info panel never prints a token value", !doc.getElementById("side").textContent.includes("ui-probe-token"));
  check("info panel says approval is off", doc.getElementById("side").textContent.includes("none — every call runs immediately"));

  // no token on the mcp port must warn
  const unsafe = await boot(true);
  unsafe.w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...INFO, httpTokenSet: false }) });
  // re-run the panel against the unsafe config by calling the page's own loader
  unsafe.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 50));
  check("warns when the mcp port has no token",
    Boolean(unsafe.w.document.querySelector("#side .warnbox")),
    unsafe.w.document.getElementById("side").textContent.slice(0, 40));
  check("no warning when the token is set", !doc.querySelector("#side .warnbox"));

  // toolbar
  const show = doc.getElementById("showtools");
  show.checked = false; show.onchange();
  check("tool rows can be hidden", doc.body.classList.contains("notools"));

  // The info panel: toggling the class must actually change what is on screen.
  check("info panel is hidden by default",
    w.getComputedStyle(doc.getElementById("side")).display === "none");
  doc.getElementById("sidebtn").click();
  check("info panel becomes visible when opened",
    w.getComputedStyle(doc.getElementById("side")).display !== "none",
    "computed display: " + w.getComputedStyle(doc.getElementById("side")).display);
  doc.getElementById("sidebtn").click();

  // the countdown element. Text alone is not enough: this shipped with the right
  // text and display:none, because `el.style.display = ''` falls back to the
  // stylesheet rather than showing anything. Check the computed value.
  const cd = doc.getElementById("countdown");
  check("countdown is hidden before anything waits", w.getComputedStyle(cd).display === "none");
  es.push({ type: "state", waiting: "ask", deadline: Date.now() + 30000 });
  await new Promise((r) => setTimeout(r, 400));
  check("countdown shows remaining seconds", /\d+s/.test(cd.textContent), cd.textContent);
  check("countdown is actually visible while waiting", w.getComputedStyle(cd).display !== "none",
    "computed display: " + w.getComputedStyle(cd).display);
  es.push({ type: "state", waiting: "ask", deadline: Date.now() + 9000 });
  await new Promise((r) => setTimeout(r, 400));
  check("countdown turns urgent under 15s", cd.classList.contains("urgent"));
  check("status reads waiting for your answer", doc.getElementById("status").textContent === "waiting for your answer",
    doc.getElementById("status").textContent);
  es.push({ type: "state", waiting: null, deadline: null });
  await new Promise((r) => setTimeout(r, 400));
  check("countdown hides when answered", w.getComputedStyle(cd).display === "none",
    "computed display: " + w.getComputedStyle(cd).display);
  check("status returns to connected", doc.getElementById("status").textContent === "connected",
    doc.getElementById("status").textContent);

  // the bug this change fixes: a reconnect must restore the pill, not leave it dead
  doc.getElementById("status").className = "dead";
  doc.getElementById("status").textContent = "reconnecting…";
  es.onopen();
  check("es.onopen restores the status pill", doc.getElementById("status").textContent === "connected",
    doc.getElementById("status").textContent);

  /* ------------------------------------------------------- authorizations
   * A client asking for access is the one thing on this page that can hand away a
   * shell, and the client's own name is attacker-chosen text. Both are checked here:
   * that the card appears and is usable, and that the name is never treated as HTML.
   */
  const approvals = doc.getElementById("approvals");
  check("no approval card until something asks", w.getComputedStyle(approvals).display === "none");

  es.push({
    type: "authorizations",
    pending: [{
      id: "auth-1",
      clientName: '<img src=x onerror="window.__pwned=1">Arena agent',
      redirectUri: "https://client.example/callback",
      scopes: ["mcp"],
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
    }],
  });
  await new Promise((r) => setTimeout(r, 30));

  check("an authorization request is shown", w.getComputedStyle(approvals).display !== "none",
    "computed display: " + w.getComputedStyle(approvals).display);
  const card = approvals.querySelector(".auth");
  check("the card names the client", card?.textContent.includes("Arena agent"), card?.textContent.slice(0, 60));
  check("the card says where it would redirect", card?.textContent.includes("https://client.example/callback"));
  check("the card says what approving means", /shell on this computer/.test(card?.textContent ?? ""));
  check("a registered address is not flagged as new",
    !card?.textContent.includes("not set up in advance"), card?.textContent.slice(0, 90));
  check("a hostile client name is text, not markup",
    approvals.querySelectorAll("img").length === 0 && w.__pwned === undefined);
  check("the request raised the alert", notifyLog.includes("question"), notifyLog.join(","));

  const allowBtn = card.querySelector(".allow");
  const denyBtn = card.querySelector(".deny");
  check("the card offers both answers", allowBtn?.textContent === "Allow" && denyBtn?.textContent === "Deny");
  allowBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  const decision = calls.find((c) => c.url.includes("/oauth/decision"));
  check("Allow posts the decision to the bridge", Boolean(decision) && decision.init.method === "POST");
  check("the decision carries the request id and says yes",
    JSON.parse(decision?.init.body ?? "{}").id === "auth-1" &&
      JSON.parse(decision?.init.body ?? "{}").allow === true, decision?.init.body);

  /* An address the client named just now, which nothing here checked against
   * anything. The human reading the card is the only check, so the card has to say
   * so - this is the one case where approving grants more than was configured.
   */
  es.push({
    type: "authorizations",
    pending: [{
      id: "auth-2",
      clientName: "Configured by hand",
      redirectUri: "https://oauth-redirect.example.com/r/bridge",
      unregisteredRedirect: true,
      scopes: ["mcp"],
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
    }],
  });
  await new Promise((r) => setTimeout(r, 30));
  const freshCard = approvals.querySelector(".auth");
  check("a card for an address nobody configured says so",
    freshCard?.textContent.includes("not set up in advance"), freshCard?.textContent.slice(0, 120));
  check("and it still offers both answers",
    Boolean(freshCard?.querySelector(".allow")) && Boolean(freshCard?.querySelector(".deny")));

  es.push({ type: "authorizations", pending: [] });
  await new Promise((r) => setTimeout(r, 30));
  check("the card goes away once it is answered",
    w.getComputedStyle(approvals).display === "none",
    "computed display: " + w.getComputedStyle(approvals).display);

  /* ------------------------------------------------------------ oauth panel */
  const oauthBoot = await boot(true);
  oauthBoot.w.fetch = async () => ({ ok: true, status: 200, json: async () => OAUTH_INFO, text: async () => "" });
  oauthBoot.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 50));
  const oauthSide = oauthBoot.w.document.getElementById("side").textContent;
  check("the panel reports the authorization server", oauthSide.includes("https://bridge.example/"), oauthSide.slice(0, 80));
  check("the panel counts registered clients and live tokens",
    oauthSide.includes("2 registered") && oauthSide.includes("3 access"), oauthSide.slice(0, 120));

  // An authorization server is itself a way to authenticate, so an unset bearer token
  // is no longer the alarm it would otherwise be.
  const quiet = await boot(true);
  quiet.w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...OAUTH_INFO, httpTokenSet: false }), text: async () => "" });
  quiet.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 50));
  check("no token warning when OAuth is carrying the authentication",
    !quiet.w.document.querySelector("#side .warnbox"),
    quiet.w.document.getElementById("side").textContent.slice(0, 60));

  // ...but a UI that others can reach, where authorizations are approved, is one.
  const exposed = await boot(true);
  exposed.w.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ ...OAUTH_INFO, oauth: { ...OAUTH_INFO.oauth, uiExposed: true } }),
    text: async () => "",
  });
  exposed.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 50));
  check("an off-machine human UI is called out",
    /authorize themselves/.test(exposed.w.document.querySelector("#side .warnbox")?.textContent ?? ""));
  oauthBoot.dom.window.close();
  quiet.dom.window.close();
  exposed.dom.window.close();

  dom.window.close();
  unsafe.dom.window.close();
}

// ------------------------------------------------- composer vs approval console
/*
 * The page runs for two different reasons now: the human channel is on, or --oauth
 * is and the page is only where an authorization gets approved. In the second case
 * there is no agent listening, so a message typed into the box would go nowhere -
 * the composer is hidden, by a class, and what is asserted is the *computed* display
 * (a textContent check is exactly what let the invisible countdown ship).
 */
{
  const INFO_OFF = {
    ...INFO, human: false, humanUI: true, httpTokenSet: false,
    oauth: { enabled: true, issuer: "https://bridge.example/",
      grants: { clients: 1, pending: 0, accessTokens: 0, refreshTokens: 0 } },
  };
  const hosted = await boot();
  hosted.w.fetch = async () => ({ ok: true, status: 200, json: async () => INFO_OFF, text: async () => "" });
  hosted.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 40));
  const doc = hosted.w.document;
  const footer = doc.querySelector("footer");
  const display = hosted.w.getComputedStyle(footer).display;
  check("no composer when no agent is listening", display === "none", `computed display: ${display}`);
  check("the console says which job it is here for",
    doc.getElementById("side").textContent.includes("--human"));
  check("and the empty timeline says what will appear in it",
    doc.getElementById("log").textContent.includes("connected client"),
    doc.getElementById("log").textContent.slice(0, 60));
  hosted.dom.window.close();

  // The other half: with the human channel on the composer is there, so the check
  // above is about the flag and not about a CSS rule that hides it either way.
  const talking = await boot();
  talking.w.eval("loadInfo()");
  await new Promise((r) => setTimeout(r, 40));
  const shown = talking.w.getComputedStyle(talking.w.document.querySelector("footer")).display;
  check("with --human the composer is back", shown === "flex", `computed display: ${shown}`);
  talking.dom.window.close();
}

// ------------------------------------------------------- without the libraries
{
  const { dom, w, es } = await boot(false);
  const doc = w.document;
  es.push({ type: "history", waiting: null, deadline: null, startedAt: at, entries: [ENTRIES[0], ENTRIES[1]] });
  await new Promise((r) => setTimeout(r, 40));
  const log = doc.getElementById("log");
  check("falls back to plain text without marked", log.textContent.includes("**world**"));
  check("fallback still cannot execute html", log.querySelectorAll("script").length === 0 && w.__pwned === undefined);
  dom.window.close();
}

// ---------------------------------------------------------------- global name
/*
 * Every top-level `var` in the inline script becomes a property of `window`. For
 * the legacy accessors (`status`, `name`, `length`, ...) that assignment goes
 * through a coercing setter and is silently dropped, which is how the status pill
 * stayed on "connecting…" forever: `var status = <element>` stored the string
 * "[object HTMLSpanElement]" and every later `status.textContent = ...` was a
 * no-op on a primitive. `let`/`const` shadow safely; only `var` is a hazard.
 */
{
  const decls = [...inline[1].matchAll(/^var\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  // `el.style.display = ''` does not show anything: it removes the inline style and
  // the computed value falls back to the stylesheet. Anything hidden by a CSS rule
  // must be shown by removing a class, never by clearing an inline style.
  const cleared = [...inline[1].matchAll(/(\w+)\.style\.display\s*=\s*(?:''|""|``)/g)].map((m) => m[1]);
  check("nothing is shown by clearing style.display", cleared.length === 0,
    cleared.length ? "offenders: " + cleared.join(", ") : "");

  const probeWin = new JSDOM("<!doctype html>", { url: "http://127.0.0.1/" }).window;
  const hazards = decls.filter((n) => n in probeWin);
  check(`no top-level var shadows a window property (${decls.length} checked)`,
    hazards.length === 0, hazards.length ? "collides: " + hazards.join(", ") : "");
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall render checks passed");
process.exit(failures ? 1 : 0);
