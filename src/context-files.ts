/**
 * Project instructions: the AGENTS.md mechanism.
 *
 * The same idea as Pi and opencode. A file named AGENTS.md (CLAUDE.md is read
 * only where a directory has no AGENTS.md) in the working root, and in each
 * directory above it up to the git root, plus one global file in ~/.pimcp.
 * Nearer files come last, so they take precedence. The files are read fresh
 * each time, so an edit is seen at the next check, without a restart.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md"];

/** Each file goes into every instructions request, so a very large one is cut and the prompt says so. */
export const CONTEXT_MAX_BYTES = 64 * 1024;

export type ContextFile = {
  path: string;
  content: string;
  truncated: boolean;
  /** A hash of the whole file, so a change is visible even when the cut point hides it. */
  hash: string;
};

function readContextFile(dir: string): ContextFile | undefined {
  for (const name of CONTEXT_FILENAMES) {
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      const bytes = Buffer.from(raw, "utf8");
      const truncated = bytes.length > CONTEXT_MAX_BYTES;
      const content = truncated ? bytes.subarray(0, CONTEXT_MAX_BYTES).toString("utf8") : raw;
      const hash = createHash("sha1").update(raw).digest("hex");
      return { path: file, content, truncated, hash };
    } catch {
      // Missing or unreadable under this name: try the next one.
    }
  }
  return undefined;
}

/**
 * The directories that count for a working root: the root itself, and every
 * directory above it up to and including the git root. With no repository above
 * the root, only the root counts. Returned git root first.
 */
export function scopeDirs(root: string): string[] {
  const start = path.resolve(root);
  const chain = [start];
  let dir = start;
  while (!existsSync(path.join(dir, ".git"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return [start];
    chain.push(parent);
    dir = parent;
  }
  return chain.reverse();
}

/** Global file first, then the scope from the git root down to the working root. */
export function loadProjectContext(
  root: string,
  globalDir: string = path.join(os.homedir(), ".pimcp"),
): ContextFile[] {
  const out: ContextFile[] = [];
  const seen = new Set<string>();
  for (const dir of [globalDir, ...scopeDirs(root)]) {
    const file = readContextFile(dir);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}
