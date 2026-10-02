import path from "node:path";

export type Config = {
  root: string;
  tools: string[];
  approve: string[];
  deny: string[];
  blockMs: number;
  uiPort: number;
  uiHost: string;
  uiToken: string;
  http: boolean;
  httpHost: string;
  httpPort: number;
  httpToken: string;
  serverName: string;
};

const DEFAULT_TOOLS = ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"];
const DEFAULT_DENY = [".ssh", ".aws", ".gnupg", ".git-credentials", ".netrc", ".config/gcloud"];

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

/** Resolve configuration from CLI flags, then environment, then defaults. */
export function loadConfig(argv: string[]): Config {
  const f = parseFlags(argv);
  const env = process.env;

  const root = path.resolve(
    str(f.root, env.PI_MCP_ROOT ?? process.cwd()),
  );
  const tools = list(str(f.tools, env.PI_MCP_TOOLS ?? "") || undefined, DEFAULT_TOOLS);
  const approve = list(str(f.approve, env.PI_MCP_APPROVE ?? "") || undefined, []);
  const deny = list(str(f.deny, env.PI_MCP_DENY ?? "") || undefined, DEFAULT_DENY);

  const http = f.http === true || env.PI_MCP_HTTP === "1" || env.PI_MCP_HTTP === "true";

  return {
    root,
    tools,
    approve,
    deny,
    blockMs: num(str(f["block-ms"], env.PI_MCP_BLOCK_MS ?? ""), 90000),
    uiPort: num(str(f["ui-port"], env.PI_MCP_UI_PORT ?? ""), 8790),
    uiHost: str(f["ui-host"], env.PI_MCP_UI_HOST ?? "127.0.0.1"),
    uiToken: str(f["ui-token"], env.PI_MCP_UI_TOKEN ?? ""),
    http,
    httpHost: str(f.host, env.PI_MCP_HOST ?? "127.0.0.1"),
    httpPort: num(str(f.port, env.PI_MCP_PORT ?? ""), 8765),
    httpToken: str(f.token, env.PI_MCP_TOKEN ?? ""),
    serverName: "pi-mcp",
  };
}
