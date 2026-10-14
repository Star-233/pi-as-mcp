import path from "node:path";

// Set before the dynamic import below: a static import would hoist above this
// assignment, so the config loader would already have read the developer's own
// ~/.pimcp/config.json and these "default" checks would depend on their daily
// setup. A path that does not exist reads as "no file" - a fresh machine.
process.env.PI_AS_MCP_CONFIG = path.resolve(".tmp-probe-config", "none.json");
const { loadConfig } = await import("../src/config.ts");

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
  // Same reasoning as --human: an authorization server nobody can approve on is
  // not a thing to switch on by accident.
  ["oauth", c.oauth, false],
  ["issuer", c.issuer, ""],
  ["oauthRedirects.length", c.oauthRedirects.length, 0],
  ["serverName", c.serverName, "pi-as-mcp"],
  // The web UI is not the human channel: it is the page where an authorization is
  // approved, so --oauth starts it too. Conflating the two is what made a hosted
  // client impossible to add, which is the bug this field exists to prevent.
  ["humanUI without either flag", c.humanUI, false],
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

const c3 = loadConfig(["--oauth", "--issuer", "https://mcp.example.com", "--human", "--http"]);
console.log(
  c3.oauth === true && c3.issuer === "https://mcp.example.com"
    ? "ok    oauth flags"
    : "FAIL  oauth flags " + JSON.stringify(c3),
);

// --oauth alone has to be a complete configuration now: the UI comes with it and
// the human channel stays off. That is the hosted-client case - a client added by
// pasting a client id and secret into it, where there is no conversation to have.
const hosted = loadConfig(["--oauth", "--http",
  "--oauth-redirect", "https://oauth-redirect.example.com/r/x,https://other.example.com/cb",
  "--oauth-client-id", "id-1", "--oauth-client-secret", "secret-1"]);
console.log(
  hosted.oauth === true && hosted.human === false && hosted.humanUI === true &&
    hosted.oauthRedirects.length === 2 && hosted.oauthClientId === "id-1" &&
    hosted.oauthClientSecret === "secret-1"
    ? "ok    --oauth alone brings the UI, not the human channel"
    : "FAIL  hosted client config " + JSON.stringify(hosted),
);

// The default shape, and the one the launcher always produces: a pinned pair with no
// redirect URI named up front. Nothing can name one - the client shows the human its
// callback address only after the credentials are already in it.
const lateUri = loadConfig(["--oauth", "--http",
  "--oauth-client-id", "id-2", "--oauth-client-secret", "secret-2"]);
console.log(
  lateUri.oauth === true && lateUri.oauthRedirects.length === 0 && lateUri.oauthClientId === "id-2" &&
    lateUri.oauthClientSecret === "secret-2"
    ? "ok    a pinned pair is a valid configuration with no --oauth-redirect"
    : "FAIL  default client config " + JSON.stringify(lateUri),
);

// The project was renamed from pi-mcp, and the environment prefix moved with it.
// Nothing is deployed yet, so the old names are gone rather than aliased - but this
// is the check that would notice if only half the rename had happened.
process.env.PI_AS_MCP_OAUTH = "1";
process.env.PI_AS_MCP_PORT = "9310";
process.env.PI_AS_MCP_OAUTH_REDIRECT = "https://env.example.com/cb";
const c4 = loadConfig([]);
console.log(
  c4.oauth === true && c4.httpPort === 9310 && c4.oauthRedirects[0] === "https://env.example.com/cb"
    ? "ok    env answers to PI_AS_MCP_"
    : "FAIL  env prefix " + JSON.stringify({ oauth: c4.oauth, port: c4.httpPort, r: c4.oauthRedirects }),
);
delete process.env.PI_AS_MCP_OAUTH;
delete process.env.PI_AS_MCP_PORT;
delete process.env.PI_AS_MCP_OAUTH_REDIRECT;

process.env.PI_MCP_PORT = "9320";
const c5 = loadConfig([]);
console.log(
  c5.httpPort === 8777
    ? "ok    the old PI_MCP_ names are gone, not quietly aliased"
    : "FAIL  the old PI_MCP_PORT was still read: " + c5.httpPort,
);
delete process.env.PI_MCP_PORT;

process.exit(bad ? 1 : 0);
