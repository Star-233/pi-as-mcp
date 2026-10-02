import type { Sandbox } from "./sandbox.ts";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: ContentPart[]; isError?: boolean };

export type AdaptedTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  snippet: string | undefined;
  guidelines: string[];
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
};

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi does not export its tool modules from the package root (only via the CLI
 * entry point, which drags in the TUI and wasm stack). The `exports` map has no
 * subpath for them either, so resolve the package directory and import the file
 * directly. Only that module graph loads: no TUI, no native image codecs.
 */
async function importPiToolModule(): Promise<any> {
  const entry = import.meta.resolve(PI_PACKAGE);
  const pkgRoot = new URL("../", entry);
  const url = new URL("dist/core/tools/index.js", pkgRoot);
  return await import(url.href);
}

/** Pi returns provider-shaped parts; MCP wants its own. Normalize both shapes. */
export function normalizeContent(content: unknown): ContentPart[] {
  const parts = Array.isArray(content) ? content : [];
  const out: ContentPart[] = [];
  for (const raw of parts) {
    const p = raw as Record<string, any>;
    if (p?.type === "text" && typeof p.text === "string") {
      out.push({ type: "text", text: p.text });
      continue;
    }
    if (p?.type === "image") {
      const data = p.data ?? p.source?.data;
      const mimeType = p.mimeType ?? p.media_type ?? p.source?.media_type ?? p.source?.mimeType;
      if (typeof data === "string" && typeof mimeType === "string") {
        out.push({ type: "image", data, mimeType });
        continue;
      }
    }
    out.push({ type: "text", text: JSON.stringify(raw) });
  }
  if (out.length === 0) out.push({ type: "text", text: "(no output)" });
  return out;
}

/** Which argument of each Pi tool carries a filesystem path. */
const PATH_ARG: Record<string, string> = {
  read: "path",
  write: "path",
  edit: "path",
  ls: "path",
  grep: "path",
  find: "path",
};

export type PiTools = {
  tools: AdaptedTool[];
  available: string[];
  missing: string[];
};

/**
 * Load Pi's own tool definitions and re-expose them as MCP tools. Descriptions,
 * JSON schemas and prompt metadata all come from Pi verbatim, so nothing drifts.
 */
export async function loadPiTools(
  cwd: string,
  wanted: string[],
  sandbox: Sandbox,
): Promise<PiTools> {
  const mod = await importPiToolModule();
  // Pi exposes PI_SESSION_ID / PI_MODEL to shell commands from the live session.
  // There is no session here, so turn that off: it also drops the prompt
  // guideline that tells the model to read those variables.
  const defs: Record<string, any> = mod.createAllToolDefinitions(cwd, {
    bash: { exposeSessionEnvironment: false },
    powershell: { exposeSessionEnvironment: false },
  });
  const available = Object.keys(defs);
  const missing = wanted.filter((n) => !(n in defs));
  const tools: AdaptedTool[] = [];

  for (const name of wanted) {
    const def = defs[name];
    if (!def) continue;
    const pathArg = PATH_ARG[name];

    tools.push({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters,
      snippet: def.promptSnippet,
      guidelines: [...(def.promptGuidelines ?? [])],
      async call(args, signal) {
        try {
          const effective: Record<string, unknown> = { ...args };
          if (pathArg) {
            const raw = effective[pathArg];
            // Default to the sandbox root rather than the bridge process cwd.
            effective[pathArg] = raw === undefined || raw === ""
              ? sandbox.root
              : sandbox.resolve(String(raw));
          }
          const res = await def.execute(
            `mcp-${Date.now()}`,
            effective,
            signal,
            undefined,
            { cwd: sandbox.root } as any,
          );
          return { content: normalizeContent(res?.content) };
        } catch (err) {
          return {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    });
  }

  return { tools, available, missing };
}
