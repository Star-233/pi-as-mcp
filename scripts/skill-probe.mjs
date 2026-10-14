/**
 * The skill probe: skills are discovered, listed by address, read through
 * skill://, kept read-only, and announced once when they change.
 *
 * Part one checks discovery and containment directly: the global directory, the
 * project directories from the git root down to the working root, the precedence
 * rules, the frontmatter rules, and every path that leaves a skill. Part two
 * starts the bridge with HOME pointed at a temp dir and checks the instructions,
 * the read through skill://, the read-only rule, and that a change reaches the
 * agent once.
 *
 * The temp tree lives under the OS temp dir. Its repository is a directory with a
 * .git inside, so nothing above it counts.
 *
 * Usage: node scripts/skill-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills, resolveSkillPath, SkillError } from "../src/skills.ts";
import { ToolChangeTracker } from "../src/tool-watch.ts";

const repo = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "skill-probe-"));
const home = path.join(base, "home");
const project = path.join(base, "project");
const sub = path.join(project, "sub");
const PORT = 18793;
const TOKEN = "skill-probe-token";

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
const put = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const skillFile = (name, description, body = `${name} body`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

// ---------------------------------------------------------------- fixtures
put(path.join(home, ".agents", "skills", "alpha", "SKILL.md"), skillFile("alpha", "global alpha"));
put(path.join(home, ".agents", "skills", "shared", "SKILL.md"), skillFile("shared", "global shared"));
put(path.join(home, ".agents", "skills", "alpha", "scripts", "run.sh"), "echo run-marker\n");
put(path.join(base, "secret.txt"), "TOP-SECRET-CONTENT\n");
put(path.join(base, ".agents", "skills", "above", "SKILL.md"), skillFile("above", "outside the repository"));
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
put(path.join(project, ".agents", "skills", "beta", "SKILL.md"), skillFile("beta", "project beta"));
put(path.join(project, ".claude", "skills", "gamma", "SKILL.md"), skillFile("gamma", "project gamma"));
put(path.join(project, ".pi", "skills", "delta", "SKILL.md"), skillFile("delta", "project delta"));
put(path.join(project, ".agents", "skills", "shared", "SKILL.md"), skillFile("shared", "project shared"));
put(path.join(project, ".agents", "skills", "near", "SKILL.md"), skillFile("near", "far near"));
put(path.join(project, ".agents", "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\nno description\n");
put(path.join(project, ".agents", "skills", "noname", "SKILL.md"), "---\ndescription: no name\n---\n");
put(path.join(project, ".agents", "skills", "empty", "README.md"), "not a skill\n");
put(path.join(sub, ".agents", "skills", "near", "SKILL.md"), skillFile("near", "near near"));
put(path.join(sub, ".agents", "skills", "quoted", "SKILL.md"), "---\nname: \"quoted\"\ndescription: 'quoted description'\n---\nbody\n");

// ---------------------------------------------------------------- part one
{
  const found = discoverSkills(sub, home);
  const byName = Object.fromEntries(found.map((s) => [s.name, s]));
  const expected = ["alpha", "beta", "delta", "gamma", "near", "pimcp", "quoted", "shared"];
  check("finds the global skills and every project directory", JSON.stringify(Object.keys(byName).sort()) === JSON.stringify(expected), JSON.stringify(Object.keys(byName)));
  check("skips a skill with no description, a skill with no name, and a folder with no SKILL.md",
    !("nodesc" in byName) && !("noname" in byName) && !("empty" in byName));
  check("does not look above the git root", !("above" in byName));
  check("a project skill overrides a global one with the same name", byName.shared?.description === "project shared");
  check("the nearer directory wins over the farther one", byName.near?.description === "near near");
  check("quoted frontmatter values are unquoted", byName.quoted?.name === "quoted" && byName.quoted?.description === "quoted description");
  check("each skill is addressed as skill://<name>/SKILL.md", byName.beta?.location === "skill://beta/SKILL.md");
  check("the built-in pimcp skill ships with the bridge", !!byName.pimcp && fs.realpathSync(byName.pimcp.dir) === fs.realpathSync(path.join(repo, "builtin-skills", "pimcp")));
  put(path.join(home, ".agents", "skills", "pimcp", "SKILL.md"), skillFile("pimcp", "a global copy"));
  check("a global skill with the built-in name overrides it", discoverSkills(sub, home).find((s) => s.name === "pimcp")?.description === "a global copy");
  fs.rmSync(path.join(home, ".agents", "skills", "pimcp"), { recursive: true, force: true });

  const real = (p) => fs.realpathSync(p);
  const opens = (addr) => {
    try {
      return real(resolveSkillPath(sub, addr, home));
    } catch (err) {
      return `error: ${err.message}`;
    }
  };
  check("skill://<name>/SKILL.md opens that skill's file",
    opens("skill://alpha/SKILL.md") === real(path.join(home, ".agents", "skills", "alpha", "SKILL.md")), opens("skill://alpha/SKILL.md"));
  check("a bare skill:// name opens its SKILL.md", opens("skill://beta") === real(path.join(project, ".agents", "skills", "beta", "SKILL.md")));
  check("a file inside a skill opens through the same address", opens("skill://alpha/scripts/run.sh") === real(path.join(home, ".agents", "skills", "alpha", "scripts", "run.sh")));

  const refused = (addr) => {
    try {
      resolveSkillPath(sub, addr, home);
      return undefined;
    } catch (err) {
      return err instanceof SkillError ? err.message : `not a SkillError: ${err}`;
    }
  };
  check("a path that climbs out of its skill is refused", refused("skill://alpha/../../../secret.txt")?.includes("outside") === true, String(refused("skill://alpha/../../../secret.txt")));
  check("a backslash climb is refused too", refused("skill://alpha/..\\..\\..\\secret.txt") !== undefined);
  check("an unknown skill is refused, and the error lists the known ones", refused("skill://nope/SKILL.md")?.includes("alpha") === true, String(refused("skill://nope/SKILL.md")));
  check("a missing file in a skill is refused", refused("skill://alpha/missing.md") !== undefined);
  check("a directory is not a file", refused("skill://alpha/scripts") !== undefined);
  try {
    fs.symlinkSync(path.join(base, "secret.txt"), path.join(home, ".agents", "skills", "alpha", "leak.txt"), "file");
    check("a symlink out of its skill is refused", refused("skill://alpha/leak.txt") !== undefined);
  } catch (err) {
    console.log(`skip symlink check (${err.code ?? err.message}) - the platform did not allow creating the link`);
  }
}
{
  const t = new ToolChangeTracker();
  const entry = (name, description) => ({ name, description, hash: `${name}:${description}` });
  t.served([], [], [entry("alpha", "a"), entry("beta", "b")]);
  check("no skill notice while skills are unchanged", t.takeNotice([], [], [entry("alpha", "a"), entry("beta", "b")]) === undefined);
  const n = t.takeNotice([], [], [entry("alpha", "a2"), entry("zeta", "z")]);
  check("a changed, added and removed skill are all announced",
    !!n && n.includes("~ skill: alpha changed") && n.includes("+ skill: zeta") && n.includes("- skill: beta removed"), String(n));
  check("the same skill change is announced once", t.takeNotice([], [], [entry("alpha", "a2"), entry("zeta", "z")]) === undefined);
}

// ---------------------------------------------------------------- part two
const logs = [];
const child = spawn(process.execPath, ["src/index.ts", "--root", sub, "--http", "--port", String(PORT), "--token", TOKEN], {
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
  check("the instructions list the skills, each by its address",
    first.includes("<available_skills>") && first.includes("<location>skill://beta/SKILL.md</location>") && first.includes("<name>alpha</name>"));
  check("the instructions carry no real skill path", !first.includes("skills/alpha") && !first.includes("skills\\alpha"));

  const opened = await call("read", { path: "skill://alpha/SKILL.md" });
  check("read opens a global skill through its address", !opened.result?.isError && textOf(opened).includes("alpha body"), textOf(opened).slice(0, 200));
  const script = await call("read", { path: "skill://alpha/scripts/run.sh" });
  check("read opens a file inside a skill", textOf(script).includes("run-marker"), textOf(script).slice(0, 200));
  const builtinDoc = await call("read", { path: "skill://pimcp/SKILL.md" });
  check("the built-in pimcp skill opens through its address", textOf(builtinDoc).includes("Configuring the pimcp bridge"), textOf(builtinDoc).slice(0, 200));
  check("the built-in skill is listed by its address", first.includes("<name>pimcp</name>") && first.includes("<location>skill://pimcp/SKILL.md</location>"));
  check("the built-in skill is not copied into an agent's directory", !fs.existsSync(path.join(home, ".agents", "skills", "pimcp")));
  const unknown = await call("read", { path: "skill://nope/SKILL.md" });
  check("an unknown skill is an error that lists the known ones", unknown.result?.isError === true && textOf(unknown).includes("Unknown skill") && textOf(unknown).includes("alpha"), textOf(unknown).slice(0, 200));
  const escape = await call("read", { path: "skill://alpha/../../../secret.txt" });
  check("a skill path cannot leave its skill", escape.result?.isError === true && !textOf(escape).includes("TOP-SECRET-CONTENT"), textOf(escape).slice(0, 200));
  const written = await call("write", { path: "skill://alpha/SKILL.md", content: "x" });
  check("a skill path is read-only", written.result?.isError === true && textOf(written).includes("read-only"), textOf(written).slice(0, 200));
  check("the read-only refusal wrote nothing", fs.readFileSync(path.join(home, ".agents", "skills", "alpha", "SKILL.md"), "utf8").includes("global alpha"));

  // Change the skills on disk; the next result announces each change once.
  put(path.join(home, ".agents", "skills", "alpha", "SKILL.md"), skillFile("alpha", "global alpha, revised"));
  put(path.join(home, ".agents", "skills", "zeta", "SKILL.md"), skillFile("zeta", "a new skill"));
  const changed = textOf(await call("get_instructions"));
  check("an edited and a new skill are announced in the next result",
    changed.includes("[bridge notice]") && changed.includes("~ skill: alpha changed") && changed.includes("+ skill: zeta"), changed.slice(0, 300));
  check("the instructions show the new skill", changed.includes("<name>zeta</name>") && changed.includes("global alpha, revised"));
  check("the change is announced once", !textOf(await call("get_instructions")).includes("[bridge notice]"));

  fs.rmSync(path.join(home, ".agents", "skills", "zeta"), { recursive: true, force: true });
  const removed = textOf(await call("get_instructions"));
  check("a removed skill is announced", removed.includes("- skill: zeta removed"), removed.slice(0, 200));
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

console.log(failures === 0 ? "\nall skill checks passed" : `\n${failures} check(s) failed`);
// Let the event loop drain instead of calling process.exit: exiting while the
// bridge's stdio is closing trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
