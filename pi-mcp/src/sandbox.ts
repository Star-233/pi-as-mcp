import path from "node:path";

export class SandboxError extends Error {}

/**
 * Confines every path argument to a single root directory and refuses a small
 * set of credential locations. This is the only thing standing between a remote
 * model and the rest of the machine, so it fails closed.
 */
export class Sandbox {
  readonly root: string;
  private deny: string[];

  constructor(root: string, deny: string[]) {
    this.root = path.resolve(root);
    this.deny = deny.map((d) => path.resolve(this.root, d).toLowerCase());
  }

  /** Resolve a tool-supplied path against the root and verify containment. */
  resolve(input: string): string {
    const abs = path.resolve(this.root, input);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SandboxError(
        `Path escapes the sandbox root. Allowed root: ${this.root}`,
      );
    }
    const lower = abs.toLowerCase();
    for (const d of this.deny) {
      if (lower === d || lower.startsWith(d + path.sep)) {
        throw new SandboxError(`Path is on the deny list: ${path.relative(this.root, abs)}`);
      }
    }
    return abs;
  }

  /** Resolve an optional path argument, leaving it undefined when absent. */
  resolveOptional(input: unknown): string | undefined {
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
