import path from "node:path";

export const PROJECT = "pi-as-mcp";

export type Config = {
  root: string;
  tools: string[];
  approve: string[];
  deny: string[];
  blockMs: number;
  /** Expose the human channel (human_say/ask/wait, the approval gate). Off by default. */
  human: boolean;
  /**
   * Whether the local web UI runs. Not the same question as `human`: a hosted client
   * (Gemini's "custom connected app") is configured by pasting credentials into *it*,
   * so the flow needs the page that carries Allow/Deny without anybody having asked
   * for the human channel. `--oauth` therefore starts the UI too, and the UI is then
   * an approval console rather than a conversation.
   */
  humanUI: boolean;
  uiPort: number;
  uiHost: string;
  uiToken: string;
  http: boolean;
  httpHost: string;
  httpPort: number;
  httpToken: string;
  /** Serve an OAuth 2.1 authorization server in front of /mcp. Off by default. */
  oauth: boolean;
  /**
   * The authorization server's identity, and the base of every URL it advertises.
   * A remote client compares it against what it discovered, so it has to be the URL
   * the client actually reached - not the loopback address the bridge binds.
   */
  issuer: string;
  /**
   * Redirect URIs for one pre-registered confidential client. A client that is
   * configured by hand instead of registering itself needs credentials *from* here
   * and needs this bridge to be told where it may send the code - the client will
   * not ask, and its URI cannot be guessed.
   */
  oauthRedirects: string[];
  /** Pinned credentials for that client, so a restart does not invalidate the paste. */
  oauthClientId: string;
  oauthClientSecret: string;
  serverName: string;
};

const DEFAULT_TOOLS =
  process.platform === "win32"
    ? ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"]
    : // The powershell tool throws on first use anywhere but Windows; advertising it
      // there only produces a tool call that always fails.
      ["read", "write", "edit", "ls", "grep", "find", "bash"];
const DEFAULT_DENY = [".ssh", ".aws", ".gnupg", ".git-credentials", ".netrc", ".config/gcloud"];
const DEFAULT_PORT = 8777;

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function num(v: string | boolean | undefined, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const trimmed = v.trim();
  if (!trimmed) return fallback; // Number("") is 0, which is never what an unset flag means
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: string | boolean | undefined, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

const truthy = (v: string | undefined): boolean => v === "1" || v === "true";

/** Resolve configuration from CLI flags, then environment, then defaults. */
export function loadConfig(argv: string[]): Config {
  const f = parseFlags(argv);
  const env = process.env;

  const root = path.resolve(
    str(f.root, env.PI_AS_MCP_ROOT ?? process.cwd()),
  );
  const tools = list(str(f.tools, env.PI_AS_MCP_TOOLS ?? "") || undefined, DEFAULT_TOOLS);
  const approve = list(str(f.approve, env.PI_AS_MCP_APPROVE ?? "") || undefined, []);
  const deny = list(str(f.deny, env.PI_AS_MCP_DENY ?? "") || undefined, DEFAULT_DENY);

  const http = f.http === true || truthy(env.PI_AS_MCP_HTTP);
  const human = f.human === true || truthy(env.PI_AS_MCP_HUMAN);
  const oauth = f.oauth === true || truthy(env.PI_AS_MCP_OAUTH);
  const httpHost = str(f.host, env.PI_AS_MCP_HOST ?? "127.0.0.1");
  const httpPort = num(str(f.port, env.PI_AS_MCP_PORT ?? ""), DEFAULT_PORT);

  return {
    root,
    tools,
    approve,
    deny,
    blockMs: num(str(f["block-ms"], env.PI_AS_MCP_BLOCK_MS ?? ""), 90000),
    human,
    humanUI: human || oauth,
    uiPort: num(str(f["ui-port"], env.PI_AS_MCP_UI_PORT ?? ""), 8790),
    uiHost: str(f["ui-host"], env.PI_AS_MCP_UI_HOST ?? "127.0.0.1"),
    uiToken: str(f["ui-token"], env.PI_AS_MCP_UI_TOKEN ?? ""),
    http,
    httpHost,
    httpPort,
    httpToken: str(f.token, env.PI_AS_MCP_TOKEN ?? ""),
    oauth,
    issuer: str(f.issuer, env.PI_AS_MCP_ISSUER ?? ""),
    oauthRedirects: list(
      str(f["oauth-redirect"], env.PI_AS_MCP_OAUTH_REDIRECT ?? "") || undefined,
      [],
    ),
    oauthClientId: str(f["oauth-client-id"], env.PI_AS_MCP_OAUTH_CLIENT_ID ?? ""),
    oauthClientSecret: str(f["oauth-client-secret"], env.PI_AS_MCP_OAUTH_CLIENT_SECRET ?? ""),
    serverName: PROJECT,
  };
}
