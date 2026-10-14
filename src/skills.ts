/**
 * Skills: on-demand instructions the agent reads through the read tool.
 *
 * A skill is a directory holding a SKILL.md whose frontmatter gives a name and a
 * description. They are found in the global ~/.agents/skills, and in the
 * project's .agents/skills, .claude/skills and .pi/skills, in every directory
 * from the git root down to the working root. A nearer directory wins over a
 * farther one, and a project skill wins over a global one with the same name.
 *
 * The agent is never shown a real path. The instructions list each skill as
 * skill://<name>/SKILL.md, and the read tool maps that address to a file. Files
 * inside a skill are addressed the same way, skill://<name>/<file>. Nothing else
 * is opened: the file must sit inside its skill directory, after symlinks are
 * resolved. Skill paths are read-only.
 *
 * The frontmatter is read one `key: value` per line, so a multi-line value is not
 * supported. The description is cut at 1024 characters, because it goes into
 * every instructions request.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scopeDirs } from "./context-files.ts";

export const SKILL_SCHEME = "skill://";
const SKILL_FILE = "SKILL.md";
/** Within one directory the later entry wins: .agents over .claude over .pi. */
const PROJECT_SKILL_DIRS = [".pi/skills", ".claude/skills", ".agents/skills"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DESCRIPTION_MAX = 1024;

export type Skill = {
  name: string;
  description: string;
  /** The directory the skill lives in. Every file it serves is inside this. */
  dir: string;
  /** The address the agent reads, e.g. skill://pdf/SKILL.md. */
  location: string;
  /** A hash of what the instructions show for this skill: name, description, address. */
  hash: string;
};

export class SkillError extends Error {}

export function isSkillPath(p: string): boolean {
  return p.startsWith(SKILL_SCHEME);
}

/** The frontmatter block: `key: value` lines between two `---` fences. */
function frontmatter(raw: string): Record<string, string> | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[kv[1]] = value;
  }
  return out;
}

const warned = new Set<string>();

/** A skill that is present but invalid is skipped, and the reason goes to stderr once. */
function skip(file: string, reason: string): undefined {
  const line = `${file}: ${reason}`;
  if (!warned.has(line)) {
    warned.add(line);
    process.stderr.write(`[pi-as-mcp] skill skipped: ${line}\n`);
  }
  return undefined;
}

function readSkillDir(skillDir: string): Skill | undefined {
  const file = path.join(skillDir, SKILL_FILE);
  let raw: string;
  try {
    if (!statSync(file).isFile()) return undefined;
    raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return undefined; // no SKILL.md here, so this is not a skill
  }
  const meta = frontmatter(raw);
  if (!meta) return skip(file, "no frontmatter (a --- block with name and description)");
  const name = meta.name ?? "";
  if (!NAME.test(name)) {
    return skip(file, `name must be 1-64 letters, digits, '.', '_' or '-', not "${name}"`);
  }
  const description = (meta.description ?? "").trim();
  if (!description) return skip(file, "description is required");
  const text = description.slice(0, DESCRIPTION_MAX);
  const location = `${SKILL_SCHEME}${name}/${SKILL_FILE}`;
  const hash = createHash("sha1").update(JSON.stringify([name, text, location])).digest("hex");
  return { name, description: text, dir: skillDir, location, hash };
}

/** Every immediate subdirectory of a skills directory that holds a valid SKILL.md. */
function skillsIn(base: string): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(base).sort();
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    const skill = readSkillDir(path.join(base, entry));
    if (skill) out.push(skill);
  }
  return out;
}

/**
 * The skills that count for a working root, one per name. Least specific first, so
 * a later directory overrides an earlier one: global, then the git root down to the
 * working root, with the project directories in PROJECT_SKILL_DIRS order.
 */
export function discoverSkills(root: string, home: string = os.homedir()): Skill[] {
  const dirs = [path.join(home, ".agents", "skills")];
  for (const dir of scopeDirs(root)) {
    for (const rel of PROJECT_SKILL_DIRS) dirs.push(path.join(dir, rel));
  }
  const byName = new Map<string, Skill>();
  for (const base of dirs) {
    for (const skill of skillsIn(base)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function inside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Map a skill:// address to the file it names, or throw a SkillError. The name must
 * be a discovered skill. The rest of the address must stay inside that skill
 * directory, both as written and after symlinks are resolved. A bare name or a
 * trailing slash means SKILL.md.
 */
export function resolveSkillPath(root: string, address: string, home?: string): string {
  const rest = address.slice(SKILL_SCHEME.length).replace(/\\/g, "/");
  const slash = rest.indexOf("/");
  const name = slash === -1 ? rest : rest.slice(0, slash);
  const rel = slash === -1 || slash === rest.length - 1 ? SKILL_FILE : rest.slice(slash + 1);

  const skills = discoverSkills(root, home);
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const known = skills.map((s) => s.name);
    throw new SkillError(`Unknown skill "${name}". Known skills: ${known.length ? known.join(", ") : "none"}.`);
  }

  const abs = path.resolve(skill.dir, rel);
  if (!inside(skill.dir, abs)) {
    throw new SkillError(`${SKILL_SCHEME}${name} refuses a path outside its skill: ${rel}`);
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new SkillError(`No such file in skill "${name}": ${rel}`);
  }
  if (!inside(realpathSync(skill.dir), real)) {
    throw new SkillError(`${SKILL_SCHEME}${name}/${rel} resolves outside its skill directory.`);
  }
  if (!statSync(real).isFile()) throw new SkillError(`${SKILL_SCHEME}${name}/${rel} is not a file.`);
  return real;
}
