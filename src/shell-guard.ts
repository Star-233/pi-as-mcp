/**
 * The shell guard: a hard stop for a short list of destructive shell commands.
 *
 * It runs before the approval gate, so it holds in every approval mode, and no
 * answer from the human lifts it. Everything else a shell may do is left to the
 * soft rule in the prompt. It is a guard against mistakes, not a security
 * boundary: a shell can always be written around a pattern, and the real limit is
 * running the bridge in a container or a VM.
 *
 * The command line is read as words. Separators (; | & ( ) ` and line breaks)
 * end a piece, except inside quotes, and quotes are removed from the words they
 * group. The command word of each piece is checked after the wrappers that run
 * another command (sudo, env, timeout, if, then, find -exec, ...). The string
 * given to a shell with -c, to cmd /c, to eval or to PowerShell -Command or
 * -EncodedCommand is checked too. Quoted text is never read as a command, so
 * `grep "shutdown" src` passes. Script files and code handed to an interpreter
 * (python -c, node -e) are not read.
 */

export type GuardBlock = { rule: string; reason: string };

const WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "time", "timeout", "exec", "command", "nice", "xargs", "stdbuf", "builtin",
  "if", "then", "else", "elif", "do", "while", "until", "!", "{",
  "-exec", "-execdir", "-ok", "-okdir", // find runs the command that follows these
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);
const DELETERS = new Set(["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri"]);
const DOS_DELETERS = new Set(["del", "erase", "rd", "rmdir"]); // their /s and /q are flags, not paths
const DISK_TOOLS = new Set(["diskpart", "format-volume", "clear-disk", "remove-partition", "initialize-disk", "wipefs"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"]);
const BOOT = new Set(["bcdedit", "bootrec"]);
const DRIVE_WORDS = new Set(["%systemdrive%", "%homedrive%", "$env:systemdrive", "$env:homedrive"]);
const HOME_WORDS = new Set(["~", "$home", "${home}", "%userprofile%", "$env:userprofile", "$env:homepath", "%homedrive%%homepath%"]);
const SYSTEM_WORDS = new Set(["%systemroot%", "$env:systemroot", "%windir%", "$env:windir"]);
const SYSTEM_DIR = /^\/(etc|usr|bin|sbin|boot|lib|lib32|lib64|var|opt|dev|proc|sys|root|home|system|library|private)$/;
const WINDOWS_DIR = /^[a-z]:\/(windows(\/system32)?|program files( \(x86\))?|programdata|users|boot|recovery)$/;
const USER_HOME = /^(\/home|\/users|[a-z]:\/users)\/[^/]+$/;
const WORKING_DIR = "everything in the working directory";
const SEPARATORS = ";|&()`";

function block(rule: string, reason: string): GuardBlock {
  return { rule, reason };
}

/** The command word, lower-cased, without a path or a .exe suffix. */
function commandName(word: string): string {
  const raw = word.toLowerCase();
  if (raw === "{" || raw === "!") return raw;
  const base = raw.replace(/^[({`$!]+/, "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|com|bat|cmd)$/, "");
}

/**
 * Splits a command line into pieces of words. A separator ends a piece, except
 * inside quotes. A backslash before ; is the find -exec terminator: it is dropped,
 * and the ; still ends the piece. With quotes off, a quote is an ordinary
 * character; that reading covers a stray apostrophe, which would otherwise hide
 * the rest of the line.
 */
function split(command: string, quotes: boolean): { pieces: string[][]; open: boolean } {
  const pieces: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endPiece = () => {
    endWord();
    if (words.length > 0) pieces.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (quotes && (ch === '"' || ch === "'")) {
      quote = ch;
      started = true;
    } else if (ch === "\\" && command[i + 1] === ";") {
      continue;
    } else if (ch === "\n" || ch === "\r" || SEPARATORS.includes(ch)) {
      endPiece();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      started = true;
    }
  }
  endPiece();
  return { pieces, open: quote !== undefined };
}

/** A flag: -x, --xxx, and for the DOS commands /x. */
function isFlag(a: string, dos: boolean): boolean {
  return /^-[^-\s]/.test(a) || /^--[a-z]/i.test(a) || (dos && /^\/[a-z]$/i.test(a));
}

function isRecursiveFlag(f: string): boolean {
  const lower = f.toLowerCase();
  if (lower === "-recurse" || lower === "--recursive" || lower === "/s") return true;
  return /^-[a-z]+$/.test(lower) && lower.includes("r") && lower !== "-force";
}

/** PowerShell accepts any unambiguous prefix of a parameter name. */
function isPsParam(a: string, full: string): boolean {
  return a.length >= 2 && a.startsWith("-") && full.startsWith(a);
}

function isHive(a: string): boolean {
  return /^(hklm|hkey_local_machine|hkcu|hkey_current_user)(:|\/|\\|$)/i.test(a);
}

/**
 * What a path names when it is one of the places a recursive delete must never
 * reach. Returns the reason, or undefined for an ordinary path.
 */
function dangerousTarget(raw: string): string | undefined {
  if (raw === "") return undefined; // bash removes nothing for an empty word
  let t = raw.toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  t = t.replace(/^\/([a-z])(?=\/|$)/, "$1:"); // Git Bash spells C:\ as /c
  for (;;) {
    const next = t.replace(/\/(\*|\.|\.\.)$/, "").replace(/\/+$/, "");
    if (next === t) break;
    t = next;
  }
  if (t === "") return "the filesystem root";
  if (t === "*" || t === "*.*" || t === ".") return WORKING_DIR;
  if (t === "..") return "the parent of the working directory";
  if (/^[a-z]:$/.test(t) || DRIVE_WORDS.has(t)) return "a drive root";
  if (HOME_WORDS.has(t) || USER_HOME.test(t)) return "a home directory";
  if (SYSTEM_WORDS.has(t) || SYSTEM_DIR.test(t) || WINDOWS_DIR.test(t)) return "a system directory";
  return undefined;
}

/** The string a shell was given to run, or undefined when it runs a file instead. */
function nestedCommand(shell: string, args: string[]): string | undefined {
  const ps = shell === "powershell" || shell === "pwsh";
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    const isCommandFlag = shell === "cmd"
      ? a === "/c" || a === "/k"
      : ps ? isPsParam(a, "-command") : /^-[a-z]*c[a-z]*$/.test(a);
    if (isCommandFlag) return args.slice(i + 1).join(" ");
    if (ps && isPsParam(a, "-encodedcommand") && i + 1 < args.length) {
      return Buffer.from(args[i + 1], "base64").toString("utf16le");
    }
  }
  return undefined;
}

function checkDelete(name: string, args: string[]): GuardBlock | undefined {
  const dos = DOS_DELETERS.has(name);
  const flags = args.filter((a) => a !== "--" && isFlag(a, dos));
  const targets = args.filter((a) => a !== "--" && !isFlag(a, dos));
  if (targets.some(isHive)) return block("registry-wipe", "deleting a registry hive");
  if (!flags.some(isRecursiveFlag)) return undefined;
  for (const t of targets) {
    const why = dangerousTarget(t);
    if (why) return block("filesystem-wipe", `a recursive delete of ${why}`);
  }
  return undefined;
}

/** chmod and chown are only refused when they reach a root, a home or a system directory. */
function checkRecursive(name: string, args: string[]): GuardBlock | undefined {
  if (!args.filter((a) => isFlag(a, false)).some(isRecursiveFlag)) return undefined;
  for (const t of args.filter((a) => !isFlag(a, false))) {
    const why = dangerousTarget(t);
    if (why && why !== WORKING_DIR) return block("permissions", `${name} -R across ${why}`);
  }
  return undefined;
}

function checkFind(args: string[], depth: number): GuardBlock | undefined {
  const lower = args.map((a) => a.toLowerCase());
  for (let k = 0; k < args.length; k++) {
    if (lower[k] === "-exec" || lower[k] === "-execdir") {
      const hit = checkWords(args.slice(k + 1), depth);
      if (hit) return hit;
    }
  }
  if (!lower.some((a) => a === "-delete" || a === "-exec" || a === "-execdir")) return undefined;
  for (const start of args) {
    if (/^-(h|l|p|x|xdev)$/i.test(start)) continue; // find's own options come before the paths
    if (start.startsWith("-") || start === "!" || start === "(") break; // the expression starts here
    const why = dangerousTarget(start);
    if (why && why !== WORKING_DIR) return block("filesystem-wipe", `find acting on ${why}`);
  }
  return undefined;
}

function checkWords(list: string[], depth: number): GuardBlock | undefined {
  if (list.length === 0) return undefined;
  const head = list[0];
  if (WRAPPERS.has(commandName(head)) || /^[a-z_][a-z0-9_]*=/i.test(head)) {
    // What runs after a wrapper's own options is the command, so check every later position.
    for (let j = 1; j < list.length; j++) {
      const hit = checkWords(list.slice(j), depth);
      if (hit) return hit;
    }
    return undefined;
  }

  const name = commandName(head);
  const args = list.slice(1);
  if (SHELLS.has(name)) {
    const nested = nestedCommand(name, args);
    return nested === undefined ? undefined : guardShell(nested, depth + 1);
  }
  if (name === "eval") return guardShell(args.join(" "), depth + 1);
  if (DELETERS.has(name)) return checkDelete(name, args);
  if (name === "chmod" || name === "chown") return checkRecursive(name, args);
  if (name === "find") return checkFind(args, depth);
  if (name.startsWith("mkfs") || DISK_TOOLS.has(name)) return block("disk-format", `${name} rewrites a disk or a partition`);
  if (name === "format" && args.some((a) => /^[a-z]:$/i.test(a))) return block("disk-format", "formatting a drive");
  if (name === "cipher" && args.some((a) => /^\/w(:|$)/i.test(a))) return block("disk-format", "cipher /w wipes the free space of a drive");
  if (name === "dd" && args.some((a) => /^of=\/dev\//i.test(a))) return block("device-write", "dd writing to a disk device");
  if (POWER.has(name)) return block("power", `${name} would stop the machine, and the bridge with it`);
  if (BOOT.has(name)) return block("boot-config", `${name} changes the boot configuration`);
  if (name === "reg" && args[0]?.toLowerCase() === "delete" && args.some(isHive)) return block("registry-wipe", "deleting a registry hive");
  return undefined;
}

/** The first destructive command in a command line, or undefined when none is found. */
export function guardShell(command: string, depth = 0): GuardBlock | undefined {
  if (depth > 4) return block("nesting", "the command is nested too deeply to check");
  const raw = command.toLowerCase();
  if (/:\s*\(\s*\)\s*\{[^}]*\|\s*:/.test(raw)) return block("fork-bomb", "a fork bomb");
  if (/>\s*\/dev\/(sd|hd|nvme|xvd|vd|disk)/.test(raw)) return block("device-write", "output redirected to a disk device");
  const readings = [split(command, true)];
  if (readings[0].open) readings.push(split(command, false)); // an unclosed quote: read it as a plain character too
  for (const { pieces } of readings) {
    for (const piece of pieces) {
      const hit = checkWords(piece, depth);
      if (hit) return hit;
    }
  }
  return undefined;
}
