import { describeCall, type ResolvedPath, type Sandbox } from "./sandbox.ts";
import { isSkillPath, resolveSkillPath } from "./skills.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi does not export its tool modules from the package root (only via the CLI
 * entry point, which drags in the TUI and native image codecs), and its `exports`
 * map has no subpath for `dist/core/tools/*` either — a static
 * `import "@earendil-works/pi-coding-agent/dist/core/tools/index.js"` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED, and Node ignores tsconfig `paths`. So only a
 * runtime resolution can work in the checkout.
 *
 * The specifier is genuinely runtime-selected, which is why this is not a static
 * import. For the packaged artifact, scripts/package.mjs rewrites this expression
 * into a literal import of src/pi-tools-entry.ts — the seam that carries the
 * tsconfig path alias — so esbuild can follow it and inline Pi's tool modules.
 * That is what lets the package ship without Pi's 143MB node_modules, while the
 * checkout keeps loading the installed package. Descriptions and schemas cannot
 * drift either way.
 */
function piToolEntryUrl(): string {
  const pkgRoot = new URL("../", import.meta.resolve(PI_PACKAGE));
  return new URL("dist/core/tools/index.js", pkgRoot).href;
}

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
  /** Ask the human to Allow or Deny a call that a deny-list path forces out of the mode. */
  requestApproval: (name: string, summary: string, reason: string) => Promise<boolean>,
): Promise<PiTools> {
  // Runtime-selected specifier (bundled literal vs. checkout resolution); see
  // piToolEntryUrl for why a static import cannot work here.
  const mod: Record<string, any> = await import(piToolEntryUrl());
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
            if (typeof raw === "string" && isSkillPath(raw)) {
              // Skills are read-only and reached only through read. resolveSkillPath
              // confines the file to its own skill directory, which is not the root.
              if (name !== "read") {
                throw new Error(`${raw} is a skill path, and skill paths are read-only. Use read.`);
              }
              effective[pathArg] = resolveSkillPath(sandbox.root, raw);
            } else {
              // Default to the root rather than the bridge process cwd.
              const resolved: ResolvedPath = raw === undefined || raw === ""
                ? { path: sandbox.root, needsApproval: false }
                : sandbox.resolve(String(raw));
              effective[pathArg] = resolved.path;
              if (resolved.needsApproval) {
                // A deny-list path is held for Allow or Deny whatever the mode is,
                // so a path the human listed is never run unattended.
                const allowed = await requestApproval(
                  name,
                  describeCall(name, effective),
                  resolved.reason ?? "the path is on the deny list",
                );
                if (!allowed) {
                  return {
                    content: [{ type: "text", text: `Denied: the human did not approve this ${name} call.` }],
                    isError: true,
                  };
                }
              }
            }
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
