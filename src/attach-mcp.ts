import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpUpstream } from "./config-file.ts";
import type { ContentPart } from "./pi-tools.ts";

/**
 * Attach other MCP servers as upstreams and re-expose their tools through this
 * bridge, prefixed with the upstream's name: a server "github" exposing "list"
 * becomes "github_list" here. One upstream going down isolates itself - its
 * calls return isError, the bridge and every other upstream keep working.
 *
 * Connections live for the life of the process, like everything else here: no
 * persistence, no sessions (AGENTS.md invariant 7). Which upstreams exist and
 * whether they are enabled is the config file's business; this module only does
 * what it is told, from startup, the file watcher, or the web UI.
 */

export type ProxiedTool = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type UpstreamStatus = "connecting" | "connected" | "error" | "disconnected";

export type UpstreamSummary = {
  name: string;
  type: string;
  status: UpstreamStatus;
  toolCount: number;
  tools: string[];
  error?: string;
  /** Mirrors config-file enabled; false = configured but off. */
  enabled: boolean;
  fromConfig: boolean;
};

type Live = {
  name: string;
  config: McpUpstream;
  status: UpstreamStatus;
  client: Client | null;
  transport: { close(): Promise<void> } | null;
  /** Prefixed tool name -> the upstream's own name for it. */
  tools: Map<string, string>;
  definitions: ProxiedTool[];
  /** Re-lists the upstream when it does not promise tools/list_changed. */
  poll?: ReturnType<typeof setInterval>;
  error?: string;
  enabled: boolean;
  fromConfig: boolean;
};

/** How often to re-list an upstream that does not promise tools/list_changed. */
const POLL_MS = 30_000;

/** Prefix characters the MCP world is happy to see in a tool name. */
function sanitize(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "upstream";
}

export type AggregatorOptions = {
  /** Rejects a prefixed name that would collide with a tool this bridge already serves. */
  reserved: (name: string) => boolean;
  log: (...args: unknown[]) => void;
};

export class McpAggregator {
  private upstreams = new Map<string, Live>();

  private opts: AggregatorOptions;

  constructor(opts: AggregatorOptions) {
    this.opts = opts;
  }

  private prefixed(upstream: string, tool: string): string {
    return `${sanitize(upstream)}_${sanitize(tool)}`;
  }

  summary(): UpstreamSummary[] {
    return [...this.upstreams.values()].map((u) => ({
      name: u.name,
      type: u.config.type,
      status: u.status,
      toolCount: u.definitions.length,
      tools: u.definitions.map((t) => t.name),
      error: u.error,
      enabled: u.enabled,
      fromConfig: u.fromConfig,
    }));
  }

  /** Every upstream's tools, flattened, ready to be served alongside Pi's. */
  tools(): ProxiedTool[] {
    const out: ProxiedTool[] = [];
    for (const u of this.upstreams.values()) {
      if (u.status !== "connected") continue;
      for (const t of u.definitions) out.push(t);
    }
    return out;
  }

  /**
   * Bring an upstream up. Idempotent: connecting twice is a no-op, so the file
   * watcher and the UI button can race without producing two child processes.
   * A failed attempt stays in the list as "error" - visible in the UI, retryable.
   */
  async connect(
    name: string,
    config: McpUpstream,
    meta: { fromConfig: boolean; enabled: boolean } = { fromConfig: true, enabled: true },
  ): Promise<{ ok: boolean; error?: string }> {
    const clean = sanitize(name);
    if (!clean) return { ok: false, error: "the upstream needs a name" };
    const existing = this.upstreams.get(name);
    if (existing && (existing.status === "connected" || existing.status === "connecting")) {
      return { ok: true };
    }

    const live: Live = {
      name,
      config,
      status: "connecting",
      client: null,
      transport: null,
      tools: new Map(),
      definitions: [],
      enabled: meta.enabled,
      fromConfig: meta.fromConfig,
    };
    this.upstreams.set(name, live);

    try {
      if (config.type === "stdio" && !config.command) {
        throw new Error("a stdio upstream needs a command");
      }
      if (config.type === "http" && !config.url) {
        throw new Error("an http upstream needs a url");
      }

      const client = new Client({ name: `pi-as-mcp-${clean}`, version: "0.1.0" }, {});
      const transport =
        config.type === "stdio"
          ? new StdioClientTransport({
              command: config.command!,
              args: config.args ?? [],
              // The SDK replaces the environment rather than merging it, and a
              // command without PATH cannot be found at all on Windows.
              env: { ...getDefaultEnvironment(), ...config.env },
            })
          : new StreamableHTTPClientTransport(new URL(config.url!), {
              requestInit: { headers: config.headers ?? {} },
            });

      await client.connect(transport);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.relist(name));
      this.ingest(live, (await client.listTools()).tools ?? []);

      live.client = client;
      live.transport = transport;
      live.status = "connected";
      live.error = undefined;
      if (!client.getServerCapabilities()?.tools?.listChanged) {
        // No promise to tell us about changes, so look again now and then.
        live.poll = setInterval(() => void this.relist(name), POLL_MS);
        live.poll.unref?.();
      }
      this.opts.log(`mcp upstream ${name}: connected, ${live.definitions.length} tool(s)`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      live.status = "error";
      live.error = message;
      live.definitions = [];
      live.tools.clear();
      try {
        await live.client?.close();
      } catch {
        /* already gone */
      }
      try {
        await live.transport?.close();
      } catch {
        /* already gone */
      }
      this.opts.log(`mcp upstream ${name}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /** Replace an upstream's tools from a fresh listing. Prefixed names that collide are skipped. */
  private ingest(
    live: Live,
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  ): void {
    live.tools.clear();
    live.definitions = [];
    for (const tool of tools) {
      const prefixed = this.prefixed(live.name, tool.name);
      if (this.opts.reserved(prefixed)) {
        this.opts.log(`mcp upstream ${live.name}: tool ${tool.name} collides with a name this bridge already serves; skipped`);
        continue;
      }
      live.tools.set(prefixed, tool.name);
      live.definitions.push({
        name: prefixed,
        description: `[via ${live.name}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object" },
      });
    }
  }

  /** Re-list a connected upstream: on its own tools/list_changed, or on a poll if it never promises one. */
  async relist(name: string): Promise<void> {
    const live = this.upstreams.get(name);
    if (!live || live.status !== "connected" || !live.client) return;
    try {
      const before = live.definitions.map((t) => t.name).join(",");
      this.ingest(live, (await live.client.listTools()).tools ?? []);
      if (live.definitions.map((t) => t.name).join(",") !== before) {
        this.opts.log(`mcp upstream ${name}: tool list changed, now ${live.definitions.length} tool(s)`);
      }
    } catch (err) {
      this.opts.log(`mcp upstream ${name}: relist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The config an upstream was connected with, so the file watcher can tell whether it changed. */
  configOf(name: string): McpUpstream | undefined {
    return this.upstreams.get(name)?.config;
  }

  /** Why a tool name cannot be called right now, when it belongs to an upstream that is not connected. */
  unavailableHint(name: string): string | undefined {
    for (const u of this.upstreams.values()) {
      if (u.status === "connected" || !name.startsWith(`${sanitize(u.name)}_`)) continue;
      const why = u.error ? ` (${u.error})` : "";
      return `Tool ${name} is unavailable: upstream "${u.name}" is ${u.status}${why}. Call get_instructions for the current upstream status.`;
    }
    return undefined;
  }

  /** Take an upstream down. Its entry stays in the list as "disconnected". */
  async disconnect(name: string): Promise<void> {
    const live = this.upstreams.get(name);
    if (!live) return;
    live.status = "disconnected";
    clearInterval(live.poll);
    live.poll = undefined;
    live.definitions = [];
    live.tools.clear();
    live.error = undefined;
    try {
      await live.client?.close();
    } catch {
      /* already gone */
    }
    try {
      await live.transport?.close();
    } catch {
      /* already gone */
    }
    live.client = null;
    live.transport = null;
    this.opts.log(`mcp upstream ${name}: disconnected`);
  }

  /** Does a prefixed tool exist right now? */
  has(name: string): boolean {
    for (const u of this.upstreams.values()) {
      if (u.status === "connected" && u.tools.has(name)) return true;
    }
    return false;
  }

  /** Forward a call, keeping the upstream's parts and its isError flag. */
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: ContentPart[]; isError?: boolean }> {
    for (const u of this.upstreams.values()) {
      if (u.status !== "connected" || !u.tools.has(name)) continue;
      try {
        const res: any = await u.client!.callTool(
          { name: u.tools.get(name)!, arguments: args },
          undefined,
          { signal },
        );
        const parts = Array.isArray(res?.content) ? res.content : [];
        const content: ContentPart[] = parts.map((p: any) =>
          p?.type === "image" && typeof p.data === "string"
            ? { type: "image", data: p.data, mimeType: p.mimeType ?? "image/png" }
            : { type: "text", text: typeof p?.text === "string" ? p.text : JSON.stringify(p) },
        );
        if (content.length === 0) content.push({ type: "text", text: "(no output)" });
        return { content, isError: Boolean(res?.isError) };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  /** Drop every upstream, for shutdown. */
  async closeAll(): Promise<void> {
    for (const name of [...this.upstreams.keys()]) {
      try {
        await this.disconnect(name);
      } catch {
        /* shutdown is best effort */
      }
    }
  }
}
