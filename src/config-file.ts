import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * The unified configuration file (~/.pimcp/config.json).
 *
 * One file owns everything a run can be steered by: the human channel, the
 * approval mode, the MCP upstreams and the Cloudflare tunnel. CLI flags still
 * exist and still win when given, but the file is the place a returning user is
 * expected to keep their setup - so it has to be readable, writable and
 * watchable, and a broken file must degrade to "no file" rather than crash
 * a bridge that has a public URL printed on the other side of the world.
 */

export type McpUpstream = {
  type: "stdio" | "http";
  /** stdio: the command to run. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the upstream's /mcp URL. */
  url?: string;
  /** http: extra headers (an Authorization token, for example). Never echoed to the UI. */
  headers?: Record<string, string>;
  /**
   * An upstream kept in the file but switched off. The UI toggle writes this:
   * it keeps the entry configured for next time while disconnecting it now.
   * Omitted means enabled, so a hand-written file needs no extra field.
   */
  enabled?: boolean;
};

export type ApprovalMode = "always" | "never";

export type TunnelFileConfig = {
  enabled?: boolean;
  /** "quick" = the random trycloudflare.com hostname; "named" = your own. */
  mode?: "quick" | "named";
  /** named: the tunnel's name on this machine. */
  name?: string;
  /** named: the path to the tunnel's credentials JSON. */
  credentialsFile?: string;
  /** named: the token of a dashboard-managed tunnel, instead of name + credentials. */
  token?: string;
  /** named: the hostname the tunnel answers on, e.g. mcp.example.com. */
  hostname?: string;
  /** Where the cloudflared binary is, when it is not on PATH. */
  cloudflaredPath?: string;
};

export type BridgeConfigFile = {
  human?: boolean;
  approval?: { mode?: ApprovalMode };
  mcps?: Record<string, McpUpstream>;
  tunnel?: TunnelFileConfig;
};

/** Where the file lives. Overridable so tests (and a second bridge) can be isolated. */
export function configFilePath(): string {
  return process.env.PI_AS_MCP_CONFIG ?? path.join(os.homedir(), ".pimcp", "config.json");
}

/**
 * Read the file. A missing file is the common case (nothing configured yet) and
 * is not an error; a malformed one is reported so the human can fix it, and is
 * otherwise ignored - a typo must not silently disable approvals or the channel.
 */
export function readFileConfig(): { config: BridgeConfigFile; error?: string } {
  const file = configFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { config: {} };
    return { config: {}, error: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: {}, error: `${file} is not a JSON object` };
    }
    return { config: parsed as BridgeConfigFile };
  } catch (err) {
    return { config: {}, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Apply one mutation to the file and save. The write is atomic (temp + rename)
 * and re-reads the current file first, so two quick UI actions cannot clobber
 * each other's fields. Returns the file as it now stands.
 */
export function writeFileConfig(update: (current: BridgeConfigFile) => void): BridgeConfigFile {
  const file = configFilePath();
  const current = readFileConfig().config;
  update(current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return current;
}

/**
 * Watch the file and hand every debounced re-read to the caller, with the
 * previous contents for diffing. Watches the directory rather than the file:
 * the atomic rename above replaces the file, and watching a replaced inode is
 * how watchers silently stop firing.
 *
 * A file that cannot be watched (no directory yet, permission) is not fatal:
 * the UI's write-back still re-reads after saving, so the bridge keeps working
 * with polling only through its own actions. Returns an unwatch function.
 */
export function watchFileConfig(
  cb: (config: BridgeConfigFile, previous: BridgeConfigFile | null) => void,
): () => void {
  const file = configFilePath();
  const watched = path.basename(file);
  let previous: BridgeConfigFile | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const read = () => {
    if (closed) return;
    const { config } = readFileConfig();
    const prev = previous;
    previous = config;
    cb(config, prev);
  };
  previous = readFileConfig().config;

  try {
    const watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, filename) => {
      if (closed) return;
      // The atomic save lands as "rename" with the exact name; ignore everything
      // else so an editor's lockfiles cannot spam the debounce.
      if (filename !== watched && filename !== `${watched}.tmp`) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 250);
    });
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
  }
}
