import { loadConfig } from "../src/config.ts";

const expectedTools =
  process.platform === "win32"
    ? ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"]
    : ["read", "write", "edit", "ls", "grep", "find", "bash"];

const c = loadConfig([]);
const checks = [
  ["blockMs", c.blockMs, 90000],
  ["uiPort", c.uiPort, 8790],
  ["httpPort", c.httpPort, 8777],
  ["uiHost", c.uiHost, "127.0.0.1"],
  ["httpHost", c.httpHost, "127.0.0.1"],
  // The human channel is off by default: a packaged deployment is a tool surface,
  // and a model told about tools it cannot call will try to call them.
  ["human", c.human, false],
  ["tools.length", c.tools.length, expectedTools.length],
  ["tools", c.tools.join(","), expectedTools.join(",")],
  ["approve.length", c.approve.length, 0],
  ["deny.length", c.deny.length, 6],
  ["http", c.http, false],
];
let bad = 0;
for (const [k, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(
    (ok ? "ok  " : "FAIL") + "  " + k + " = " + JSON.stringify(got) + (ok ? "" : " (want " + JSON.stringify(want) + ")"),
  );
}

// An explicit --tools wins over the platform default in both directions: it can
// add powershell on Linux (the tool then fails when called, but it is the user's
// call) and drop it on Windows.
const c2 = loadConfig(["--block-ms", "12345", "--http", "--port", "9001", "--root", ".", "--human"]);
console.log(
  c2.blockMs === 12345 && c2.http === true && c2.httpPort === 9001 && c2.human === true
    ? "ok    flag overrides"
    : "FAIL  flag overrides " + JSON.stringify(c2),
);

process.exit(bad ? 1 : 0);
