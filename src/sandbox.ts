import fs from "node:fs";
import path from "node:path";

export class SandboxError extends Error {}

/** A path resolved against the root, plus whether the call has to be approved first. */
export type ResolvedPath = {
  path: string;
  /** True for a deny-list path: the call waits for Allow or Deny in every approval mode. */
  needsApproval: boolean;
  /** Why it needs approval, as the card the human reads should say it. */
  reason?: string;
};

/**
 * Holds the directory that relative path arguments resolve against, and the deny
 * list. It does not confine anything: a path outside the root is resolved and
 * used, not refused. What the deny list does is escalate - a call that touches
 * one of its paths waits for a human Allow or Deny in every approval mode,
 * `never` included, so a denied path is never run unattended.
 *
 * The root is not fixed at startup: the human can move it from the web UI
 * while the bridge runs (the agent never gets a tool for it). `setRoot`
 * re-validates and recomputes the deny list, because deny entries are
 * root-relative: a stale list would still be pointing at the old directory.
 */
export class Sandbox {
  private rootValue: string;
  private denySpec: string[];
  private deny: string[];

  constructor(root: string, deny: string[]) {
    this.rootValue = path.resolve(root);
    this.denySpec = deny;
    this.deny = deny.map((d) => path.resolve(this.rootValue, d).toLowerCase());
  }

  get root(): string {
    return this.rootValue;
  }

  /**
   * Move the sandbox to another directory, at runtime. Fails closed: the new
   * root must exist and be a directory, so a typo cannot point the agent at a
   * path the human never meant. In-flight calls keep the root they resolved
   * before the switch - each path is checked and fixed at resolve time, and a
   * running shell command is not pulled out from under itself.
   */
  setRoot(newRoot: string): void {
    const resolved = path.resolve(newRoot);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new SandboxError(`The new root does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw new SandboxError(`The new root is not a directory: ${resolved}`);
    }
    this.rootValue = resolved;
    this.deny = this.denySpec.map((d) => path.resolve(this.rootValue, d).toLowerCase());
  }

  /** Resolve a tool-supplied path against the root, and say whether it is denied. */
  resolve(input: string): ResolvedPath {
    const abs = path.resolve(this.root, input);
    const lower = abs.toLowerCase();
    for (const d of this.deny) {
      if (lower === d || lower.startsWith(d + path.sep)) {
        return {
          path: abs,
          needsApproval: true,
          reason: `the path is on the deny list: ${path.relative(this.root, abs)}`,
        };
      }
    }
    return { path: abs, needsApproval: false };
  }

  /** Resolve an optional path argument, leaving it undefined when absent. */
  resolveOptional(input: unknown): ResolvedPath | undefined {
    return typeof input === "string" && input.length > 0 ? this.resolve(input) : undefined;
  }
}

/** True when the tool needs a human approval gate before it runs. */
export function needsApproval(name: string, approve: string[]): boolean {
  return approve.includes(name);
}

/** One-line human-facing summary of a tool call, for the approval prompt. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  if (name === "bash" || name === "powershell") return String(args.command ?? "");
  if (name === "write") return `write ${args.path} (${String(args.content ?? "").length} bytes)`;
  if (name === "edit") {
    const n = Array.isArray(args.edits) ? args.edits.length : 0;
    return `edit ${args.path} (${n} replacement${n === 1 ? "" : "s"})`;
  }
  return `${name} ${JSON.stringify(args).slice(0, 200)}`;
}
