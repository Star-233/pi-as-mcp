
import { loadConfig } from "../src/config.ts";
const c = loadConfig([]);
const checks = [
  ["blockMs", c.blockMs, 90000],
  ["uiPort", c.uiPort, 8790],
  ["httpPort", c.httpPort, 8777],
  ["uiHost", c.uiHost, "127.0.0.1"],
  ["httpHost", c.httpHost, "127.0.0.1"],
  ["tools.length", c.tools.length, 8],
  ["approve.length", c.approve.length, 0],
  ["deny.length", c.deny.length, 6],
  ["http", c.http, false],
];
let bad = 0;
for (const [k, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "ok  " : "FAIL") + "  " + k + " = " + JSON.stringify(got) + (ok ? "" : " (want " + JSON.stringify(want) + ")"));
}
const c2 = loadConfig(["--block-ms", "12345", "--http", "--port", "9001", "--root", "."]);
console.log(c2.blockMs === 12345 && c2.http === true && c2.httpPort === 9001 ? "ok    flag overrides" : "FAIL  flag overrides " + JSON.stringify(c2));
process.exit(bad ? 1 : 0);
