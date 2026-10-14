/**
 * Tells the agent when something it was shown has changed under it: the tool
 * list, or a project instructions file.
 *
 * The stateless HTTP transport cannot push notifications, so the bridge
 * piggybacks the news on the next tool result instead. The first tool call
 * after a change returns a short notice listing what moved, and that change is
 * then considered delivered.
 *
 * The baseline is what the agent was last told: the lists in a tools/list
 * response, or the lists at an earlier notice. It is process-wide, not per
 * client. With one agent connected, which is the normal case, that is exact.
 * With several, a tools/list from one of them clears the news for the others.
 */
import { createHash } from "node:crypto";

export type ToolEntry = { name: string; description?: string; inputSchema?: unknown };

/** A project instructions file: where it is, and a hash of what it said. */
export type ContextEntry = { path: string; hash: string };

type Fingerprint = { hash: string; description: string; params: string };
type Baseline = { tools: Map<string, Fingerprint>; contexts: Map<string, string> };

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function paramsOf(schema: unknown): string {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const required = new Set(s?.required ?? []);
  const names = Object.keys(s?.properties ?? {}).map((k) => (required.has(k) ? `${k}*` : k));
  return names.length ? names.join(", ") : "none";
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 160);
}

function fingerprint(tools: ToolEntry[], contexts: ContextEntry[]): Baseline {
  const toolMap = new Map<string, Fingerprint>();
  for (const e of tools) {
    const description = e.description ?? "";
    toolMap.set(e.name, {
      hash: sha1(JSON.stringify([description, e.inputSchema ?? null])),
      description,
      params: paramsOf(e.inputSchema),
    });
  }
  return { tools: toolMap, contexts: new Map(contexts.map((c) => [c.path, c.hash])) };
}

export class ToolChangeTracker {
  private baseline: Baseline | null = null;

  /** The agent was just given these lists (a tools/list response). */
  served(tools: ToolEntry[], contexts: ContextEntry[] = []): void {
    this.baseline = fingerprint(tools, contexts);
  }

  /**
   * Called after every tool result. Returns a notice when a list differs from the
   * baseline, and moves the baseline forward so the same change is announced once.
   * Before any list was served there is nothing to compare, so no notice.
   */
  takeNotice(tools: ToolEntry[], contexts: ContextEntry[] = []): string | undefined {
    const now = fingerprint(tools, contexts);
    const before = this.baseline;
    this.baseline = now;
    if (!before) return undefined;

    const lines: string[] = [];
    for (const [name, fp] of now.tools) {
      const old = before.tools.get(name);
      if (!old) {
        lines.push(`+ ${name}: ${firstLine(fp.description)} (params: ${fp.params})`);
      } else if (old.hash !== fp.hash) {
        lines.push(`~ ${name}: changed; ${firstLine(fp.description)} (params: ${fp.params})`);
      }
    }
    for (const name of before.tools.keys()) {
      if (!now.tools.has(name)) lines.push(`- ${name}: removed`);
    }
    for (const [file, hash] of now.contexts) {
      const old = before.contexts.get(file);
      if (old === undefined) lines.push(`+ project instructions: ${file}`);
      else if (old !== hash) lines.push(`~ project instructions: ${file} changed`);
    }
    for (const file of before.contexts.keys()) {
      if (!now.contexts.has(file)) lines.push(`- project instructions: ${file} removed`);
    }
    if (lines.length === 0) return undefined;

    return [
      "[bridge notice] Something you were shown has changed:",
      ...lines,
      "Call tools/list for the full tool list, or get_instructions for the current upstream status and project instructions.",
    ].join("\n");
  }
}
