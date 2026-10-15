/**
 * The shell-guard probe: a fixed list of destructive command lines must be
 * refused, and a list of ordinary ones must pass.
 *
 * Only guardShell() reads the strings. Nothing here runs a shell command, and
 * the destructive lines are never given to one. The bridge part sends a single
 * harmless canary through the bash tool: mkfs.bridge-canary does not exist, so
 * even if the guard failed it could only print "command not found".
 *
 * Usage: node scripts/shell-guard-probe.mjs
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardShell } from "../src/shell-guard.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`);
};

const encodedPs = Buffer.from("Remove-Item C:\\ -Recurse -Force", "utf16le").toString("base64");

const BLOCKED = [
  // filesystem roots, homes and the working directory
  "rm -rf /",
  "rm -rf /*",
  "rm -rf --no-preserve-root /",
  "rm -r -f /",
  "rm --recursive --force /",
  "sudo rm -rf /",
  "rm -rf ~",
  "rm -rf ~/.",
  "rm -rf ~/..",
  "rm -rf $HOME",
  'rm -rf "$HOME"',
  "rm -rf ${HOME}/*",
  "rm -rf .",
  "rm -rf *",
  "rm -rf ./*",
  "rm -rf ..",
  "rm -rf //home",
  "rd /s /q C:\\\\Windows",
  "rm -rf /home",
  "rm -rf /etc",
  "rm -rf /c/Users/yesno",
  "rm -rf /c",
  "rm -rf /c/",
  "rm -rf C:\\",
  "rm -rf %SystemDrive%\\",
  "chmod -R 000 /",
  "chmod -R 644 ~",
  "chown -R user /c",
  "find ~ -name x -delete",
  "find / -delete",
  "find -L / -delete",
  "find / -exec rm -rf {} \\;",
  "find . -exec ls {} \\; -exec rm -rf / \\;",
  // the same, hidden by a separator, a wrapper, a subshell or a quote
  "git status && rm -rf /",
  "npm test; rm -rf /",
  'bash -c "rm -rf /"',
  "sh -lc 'rm -rf /'",
  'bash -c "cd x; rm -rf /"',
  "timeout 5 rm -rf /",
  "env FOO=1 rm -rf /",
  "if true; then rm -rf /; fi",
  "(rm -rf /)",
  "echo $(rm -rf /)",
  "echo `rm -rf /`",
  "f() { rm -rf /; }; f",
  'eval "rm -rf /"',
  'r""m -rf /',
  '"rm" -rf /',
  "echo O'Brien; rm -rf /",
  // Windows
  "del /s /q C:\\",
  "rd /s /q C:\\Users\\yesno",
  "rd /s /q %USERPROFILE%",
  "del /s /q *.*",
  'cmd /c "rd /s /q C:\\"',
  "cmd /c rd /s /q C:\\",
  "Remove-Item C:\\ -Recurse -Force",
  "Remove-Item -Path 'C:\\Windows' -Recurse -Force",
  "Remove-Item -LiteralPath $env:USERPROFILE -Recurse -Force",
  'powershell -Command "Remove-Item C:\\ -Recurse -Force"',
  'powershell -ConfigurationName x -Command "Remove-Item C:\\ -Recurse -Force"',
  `pwsh -EncodedCommand ${encodedPs}`,
  // disks, power, boot, registry
  "format c:",
  "mkfs.ext4 /dev/sda1",
  "mkfs.bridge-canary",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "echo x > /dev/sda",
  "shutdown -h now",
  "reboot",
  "Restart-Computer -Force",
  "bcdedit /set {default} recoveryenabled no",
  "reg delete HKLM\\SOFTWARE\\Foo /f",
  "Remove-Item HKLM:\\SOFTWARE\\Foo -Recurse",
  "cipher /w:C",
  ":(){ :|:& };:",
];

const ALLOWED = [
  "git status",
  "npm test",
  "npm run build && rm -rf dist",
  "rm -rf node_modules",
  "rm -rf ./dist",
  "rm -rf build/*",
  "rm -rf /tmp/my-build",
  "rm file.txt",
  "del temp.txt",
  "rmdir empty-dir",
  "rd /s /q C:\\Users\\yesno\\AppData\\Local\\Temp\\skill-probe-x",
  "Remove-Item .\\build -Recurse",
  "Remove-Item -Path C:\\Users\\yesno\\AppData\\Local\\Temp\\x -Recurse -Force",
  'rm -rf ""',
  'rg "shutdown" src',
  "grep -r format src",
  "echo reboot is a word",
  'echo "a; rm -rf /"',
  "echo O'Brien",
  "cat /etc/hosts",
  "ls /",
  "ls -la ~",
  "mkdir -p /tmp/x",
  "dd if=a.img of=b.img",
  "find . -name '*.log' -delete",
  "find . -exec rm -rf {} \\;",
  "find -L . -name x -delete",
  "chmod 644 file.txt",
  "chmod -R 755 ./build",
  "chmod -R 755 .",
  "sudo apt-get update",
  "echo 'rm -rf /' > notes.txt",
  'git commit -m "remove old shutdown code"',
  "grep -rn 'rm -rf /' docs",
  'echo "format c:"',
  "cmd /c echo hi",
  'powershell -Command "Get-ChildItem C:\\Users"',
  "pwsh -File build.ps1",
  "node -e \"console.log(1)\"",
  "",
];

for (const cmd of BLOCKED) {
  const hit = guardShell(cmd);
  check(`refuses ${JSON.stringify(cmd)}`, !!hit, "the command was let through");
}
for (const cmd of ALLOWED) {
  const hit = guardShell(cmd);
  check(`allows ${JSON.stringify(cmd)}`, !hit, hit ? `refused as ${hit.rule}: ${hit.reason}` : "");
}
check("the refusal names its rule and reason", (() => {
  const hit = guardShell("rm -rf /");
  return !!hit && hit.rule === "filesystem-wipe" && hit.reason.includes("filesystem root");
})());
check("a line nested beyond the limit is refused", guardShell("bash -c bash -c bash -c bash -c bash -c bash -c ls")?.rule === "nesting");
check("a line nested within the limit is read", guardShell("bash -c bash -c ls") === undefined);


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------- bridge part
// The temp tree is made by mkdtemp, and only that directory is removed.
const repo = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "shell-guard-probe-"));
const home = path.join(base, "home");
const work = path.join(base, "work");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const PORT = 18794;
const TOKEN = "shell-guard-probe-token";

const logs = [];
const child = spawn(process.execPath, ["src/index.ts", "--root", work, "--http", "--port", String(PORT), "--token", TOKEN, "--ui-port", "8796"], {
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

  await rpc("tools/list");
  // mkfs.bridge-canary names no real program: if the guard failed, the line
  // could only report "command not found".
  const refused = await call("bash", { command: "mkfs.bridge-canary" });
  check("the bridge refuses a destructive line sent through bash",
    refused.result?.isError === true && textOf(refused).includes("Blocked by the shell guard [disk-format]"), textOf(refused).slice(0, 200));
  check("the refusal says the guard holds in every approval mode", textOf(refused).includes("every approval mode"), textOf(refused).slice(0, 200));
  const ran = await call("bash", { command: "echo guard-ok" });
  check("the bridge still runs a harmless line", !ran.result?.isError && textOf(ran).includes("guard-ok"), textOf(ran).slice(0, 200));
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

console.log(failures === 0 ? "\nall shell-guard checks passed" : `\n${failures} shell-guard check(s) failed`);
// Let the event loop drain instead of calling process.exit: exiting while the
// bridge's stdio is closing trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
