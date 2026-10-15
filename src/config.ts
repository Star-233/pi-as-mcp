import path from "node:path";
import {
  configFilePath,
  readFileConfig,
  type ApprovalMode,
  type BridgeConfigFile,
  type McpUpstream,
} from "./config-file.ts";

export const PROJECT = "pi-as-mcp";

export type Config = {
  root: string;
  tools: string[];
  approve: string[];
  deny: string[];
  blockMs: number;
  /**
   * Expose the human channel: human_say/ask/wait, and the chat on the web page. Off by
   * default. Approvals do not depend on it - they are Allow/Deny cards on the web page.
   */
  human: boolean;
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
  /**
   * The one approval question, for every tool alike: "always" holds each call
   * for Allow or Deny on the web page, "never" lets every call run. The per-tool
   * --approve list is gone in spirit: the flag is still accepted, but only as a
   * way to say "always".
   */
  approvalMode: ApprovalMode;
  /** Upstream MCP servers from the config file, by name. Hot-managed at runtime. */
  mcps: Record<string, McpUpstream>;
  configPath: string;
  /** Set when ~/.pimcp/config.json exists but could not be parsed - the file was ignored. */
  configFileError?: string;
};

const DEFAULT_TOOLS =
  process.platform === "win32"
    ? ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"]
    : // The powershell tool throws on first use anywhere but Windows; advertising it
      // there only produces a tool call that always fails.
      ["read", "write", "edit", "ls", "grep", "find", "bash"];
// Empty by default: what is denied is the human's choice (--deny or PI_AS_MCP_DENY).
const DEFAULT_DENY: string[] = [];
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

/**
 * Resolve configuration: an explicit CLI flag first, then the config file
 * (~/.pimcp/config.json), then the environment, then defaults. The file sits
 * above the environment because it is what the human edits on purpose; flags
 * sit above everything because a one-off command must be able to try something
 * without rewriting the file first.
 */
export function loadConfig(argv: string[]): Config {
  const f = parseFlags(argv);
  const env = process.env;
  const fileRead = readFileConfig();
  const file: BridgeConfigFile = fileRead.config;
  const configFileError: string | undefined = fileRead.error;

  const root = path.resolve(
    str(f.root, env.PI_AS_MCP_ROOT ?? process.cwd()),
  );
  const tools = list(str(f.tools, env.PI_AS_MCP_TOOLS ?? "") || undefined, DEFAULT_TOOLS);
  const approve = list(str(f.approve, env.PI_AS_MCP_APPROVE ?? "") || undefined, []);
  const deny = list(str(f.deny, env.PI_AS_MCP_DENY ?? "") || undefined, DEFAULT_DENY);

  const http = f.http === true || truthy(env.PI_AS_MCP_HTTP);
  // --human / --no-human are explicit; otherwise the file; otherwise the env.
  const human =
    f.human === true ? true
    : f["no-human"] === true ? false
    : file.human !== undefined ? file.human
    : truthy(env.PI_AS_MCP_HUMAN);
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
    approvalMode: f.approve !== undefined
      ? "always"
      : file.approval?.mode === "always" || file.approval?.mode === "never"
        ? file.approval.mode
        : "never",
    mcps: file.mcps ?? {},
    configPath: configFilePath(),
    configFileError,
  };
}
