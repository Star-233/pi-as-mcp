#!/usr/bin/env node
/**
 * package.mjs — build a portable pi-mcp bundle somebody else can run.
 *
 *   node scripts/package.mjs            # for the host platform
 *   node scripts/package.mjs --win32    # cross-build for Windows from Linux
 *   node scripts/package.mjs --linux    # cross-build for Linux from Windows
 *
 * Output lands in dist/<platform>-<arch>/ and is self-contained:
 *
 *   dist/win32-x64/
 *     pimcp.cmd            double-click launcher (Windows)
 *     pimcp.sh             launcher (Linux/macOS)
 *     runtime/             the Node runtime, so the target machine needs nothing
 *     app/                 bundled JS + the pi tool graph + the human UI assets
 *
 * The bridge is not an agent, so nothing here downloads anything: the whole
 * point is that the recipient gets a directory that works offline.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");

const NODE_VERSION = process.versions.node.replace(/^v/, "");

/** Node ships prebuilt binaries per platform at a fixed URL shape. */
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
const NODE_TARGETS = {
  "win32-x64": { file: `node-v${NODE_VERSION}-win-x64.zip`, exe: "node.exe" },
  "linux-x64": { file: `node-v${NODE_VERSION}-linux-x64.tar.xz`, exe: "node" },
};

function log(...a) {
  process.stdout.write(`[package] ${a.join(" ")}\n`);
}
function fail(msg) {
  process.stderr.write(`[package] ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

function hostPlatform() {
  const key = `${process.platform}-${process.arch}`;
  if (!NODE_TARGETS[key]) fail(`unsupported host platform: ${key}`);
  return key;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Bundle the bridge itself. Pi's tool modules stay external: they are resolved
 * from node_modules at runtime by src/pi-tools.ts, which is deliberate (see the
 * README invariant) - bundling them would pin their schemas into the artifact.
 */
async function bundle(outFile) {
  // The JS API, not the .bin shim: esbuild.cmd needs a shell and spawnSync
  // without one reports a null exit status.
  const { pathToFileURL } = await import("node:url");
  const { build } = await import(pathToFileURL(path.join(REPO, "node_modules", "esbuild", "lib", "main.js")).href);
  await build({
    entryPoints: [path.join(REPO, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: outFile,
    // Loaded from the packaged node_modules, not from the bundle.
    // NOTE: do not mark *.json external. ajv does a dynamic require of its
    // refs/data.json, which ESM cannot do, and the CJS interop shim only works
    // when esbuild has bundled the JSON itself.
    external: ["@earendil-works/pi-coding-agent"],
    logLevel: "warning",
  });
}

/**
 * The parts of node_modules the bridge actually loads. The full tree is 223MB
 * because Pi's own dependencies include SDKs for providers this bridge never
 * talks to (Anthropic, Google, AWS, protobuf). Pruned to the modules that are
 * imported, verified by running the packaged server with --tools including bash.
 *
 * This is a copy, not a symlink or a hoist: the recipient's machine has no npm.
 */
const KEEP_TOP = [
  "@earendil-works/pi-coding-agent",
  "@modelcontextprotocol",
  "@silvia-odwyer",
];

/**
 * Packages npm installed inside Pi's own node_modules. Resolution matters here:
 * a package imported from dist/core/tools/*.js finds Pi's nested copy first, so
 * "chalk" must be kept in the nested dir, not hoisted to the top level, or the
 * packaged tree fails with ERR_MODULE_NOT_FOUND for a package that is present.
 *
 * Verified by running the packaged artifact; the provider SDKs (Anthropic,
 * Google, AWS, protobuf, esbuild binaries) are the weight this drops.
 */
const KEEP_PI_NESTED = [
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-tui",
  "chalk",
  "diff",
  "marked",
  "typebox",
];

function copyNodeModules(dest) {
  const src = path.join(REPO, "node_modules");
  for (const name of KEEP_TOP) {
    const from = path.join(src, name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dest, name), { recursive: true });
  }

  // Pi vendors its own dependency versions. Copy only the ones the tool graph
  // resolves from there, so the layout keeps matching what the imports expect.
  const piNestedSrc = path.join(src, "@earendil-works", "pi-coding-agent", "node_modules");
  const piNested = path.join(dest, "@earendil-works", "pi-coding-agent", "node_modules");
  fs.mkdirSync(piNested, { recursive: true });
  for (const rel of KEEP_PI_NESTED) {
    const from = path.join(piNestedSrc, rel);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(piNested, rel), { recursive: true });
  }
}

/** The human UI's vendored marked + KaTeX, plus the page itself. */
function copyUi(dest) {
  const from = path.join(REPO, "src", "human");
  fs.cpSync(path.join(from, "ui.html"), path.join(dest, "ui.html"));
  fs.cpSync(path.join(from, "vendor"), path.join(dest, "vendor"), { recursive: true });
}

function writeLaunchers(target, outDir, appDir, runtimeDir) {
  if (target === "win32-x64") {
    fs.writeFileSync(
      path.join(outDir, "pimcp.cmd"),
      `@echo off
rem pi-mcp launcher. Everything it needs is in this directory, including the Node
rem runtime and cloudflared, so this does not touch PATH and needs nothing installed.
setlocal
set "PIMCP_HOME=%~dp0"
"%PIMCP_HOME%${runtimeDir}\\node.exe" "%PIMCP_HOME%pimcp.mjs" %*
`,
    );
  } else {
    const launcher = path.join(outDir, "pimcp.sh");
    fs.writeFileSync(
      launcher,
      `#!/usr/bin/env bash
# pi-mcp launcher. Everything it needs is in this directory.
#
# Deliberately uses no external commands: parameter expansion instead of dirname,
# and an absolute path to the bundled runtime instead of PATH lookup. The point of
# the package is that it runs on a machine with no Node and a broken PATH.
set -uo pipefail
PIMCP_HOME="\${BASH_SOURCE[0]}"
PIMCP_HOME="\${PIMCP_HOME%/*}"
exec "$PIMCP_HOME/${runtimeDir}/node" "$PIMCP_HOME/pimcp.mjs" "$@"
`,
    );
    fs.chmodSync(launcher, 0o755);
  }
}

function downloadNode(target, runtimeDir) {
  const t = NODE_TARGETS[target];
  const url = `${NODE_BASE}/${t.file}`;
  const tmp = path.join(DIST, t.file);
  if (!fs.existsSync(tmp)) {
    log(`downloading ${url}`);
    run(process.platform === "win32" ? "curl" : "curl", ["-fsSL", "-o", tmp, url]);
  }
  log(`extracting ${t.file}`);
  const work = path.join(DIST, ".node-extract");
  rmrf(work);
  fs.mkdirSync(work, { recursive: true });
  if (t.file.endsWith(".zip")) {
    run("tar", ["-xf", tmp, "-C", work]);
  } else {
    run("tar", ["-xJf", tmp, "-C", work]);
  }
  const inner = fs.readdirSync(work).find((d) => d.startsWith(`node-v${NODE_VERSION}`));
  if (!inner) fail("could not find the extracted node directory");
  const from = path.join(work, inner);
  const dest = path.join(DIST, target, runtimeDir);
  fs.mkdirSync(dest, { recursive: true });
  // Copy the tree, then drop the toolchain bits the bridge never touches. Doing it
  // as a copy-then-prune is more reliable than a recursive filter: cpSync's filter
  // cannot know a parent dir was kept for a child we mean to drop, and stat on a
  // path the filter already rejected races with the walk.
  fs.cpSync(from, dest, { recursive: true });
  const exe = target === "win32-x64" ? "node.exe" : "node";
  for (const drop of ["include", "CHANGELOG.md", "LICENSE", "README.md"]) {
    rmrf(path.join(dest, drop));
  }
  // The Windows zip puts node.exe at the archive root with npm/npx/corepack beside
  // it; the Linux tarball puts node at bin/ with the same companions. Normalize to
  // runtime/<exe> in both cases so the launchers name one path.
  const nested = path.join(dest, "bin", exe);
  if (fs.existsSync(nested)) {
    fs.copyFileSync(nested, path.join(dest, exe));
    fs.chmodSync(path.join(dest, exe), 0o755);
    rmrf(path.join(dest, "bin"));
  }
  for (const entry of fs.readdirSync(dest)) {
    if (entry !== exe && entry !== "lib" && entry !== "share") rmrf(path.join(dest, entry));
  }
  rmrf(work);
}

/**
 * Ask WSL where its cloudflared is and read it out through stdout. Streaming the
 * bytes is deliberate: passing a Windows path to `wsl cp` makes WSL treat it as a
 * literal filename, mangling the drive colon and spaces into fullwidth characters
 * and writing the file somewhere useless.
 */
function wslLinuxCloudflared() {
  const found = spawnSync("wsl", ["-e", "bash", "-lc", "command -v cloudflared"], {
    encoding: "utf8",
  });
  const remote = (found.stdout || "").trim().split("\n").pop()?.trim();
  if (!remote || found.status !== 0) return [];

  const staged = path.join(DIST, ".wsl-cloudflared");
  const dumped = spawnSync("wsl", ["-e", "cat", remote], { maxBuffer: 256 * 1024 * 1024 });
  if (dumped.status !== 0 || !dumped.stdout) return [];
  fs.writeFileSync(staged, dumped.stdout);
  fs.chmodSync(staged, 0o755);
  return [staged];
}

/**
 * Vendor cloudflared into the package, so a machine with nothing installed can
 * still open a public URL.
 *
 * Order matters, and it is about *portability*, not just availability:
 *
 *  1. The GitHub release first. Its ELF interpreter is the standard
 *     `/lib64/ld-linux-x86-64.so.2`, so it runs on any x86-64 Linux.
 *  2. A local install only as an offline fallback — and only after rewriting the
 *     interpreter if it is a non-standard one. A Homebrew copy points at
 *     `/home/linuxbrew/.linuxbrew/lib/ld.so`, which does not exist on the
 *     recipient's machine, so shipping it verbatim produces "No such file or
 *     directory" on the binary itself. `patchelf --set-interpreter` fixes that;
 *     without patchelf the copy is still shipped but the reason it may not run is
 *     logged.
 *
 * Missing cloudflared is not an error: the bridge still runs, just without a
 * tunnel, and the launcher says so.
 */
function vendorCloudflared(target, binDir) {
  const exe = target === "win32-x64" ? "cloudflared.exe" : "cloudflared";
  const dest = path.join(binDir, exe);
  fs.mkdirSync(binDir, { recursive: true });

  const localCandidates = target === "win32-x64"
    ? [
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
    ]
    : [
      // Linux, built from Windows: the local copy lives inside WSL, not at a path
      // the Windows process can see, so ask WSL for it.
      ...(process.platform === "win32" ? wslLinuxCloudflared() : [
        "/home/linuxbrew/.linuxbrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
      ]),
    ];

  // 1. The portable official release.
  const url = target === "win32-x64"
    ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  log(`downloading ${url}`);
  const tmp = path.join(DIST, exe);
  const fetched = spawnSync("curl", ["-fsSL", "--max-time", "300", "-o", tmp, url]);
  if (fetched.status === 0 && fs.existsSync(tmp)) {
    fs.copyFileSync(tmp, dest);
    fs.chmodSync(dest, 0o755);
    rmrf(tmp);
    log(`vendored cloudflared from the official release`);
    return;
  }
  log("could not download cloudflared — falling back to a local install");

  // 2. A local install, made portable if it is not.
  for (const c of localCandidates) {
    if (!fs.existsSync(c)) continue;
    fs.copyFileSync(c, dest);
    fs.chmodSync(dest, 0o755);
    const interpreter = elfInterpreter(dest);
    const portable = !interpreter || interpreter === "/lib64/ld-linux-x86-64.so.2";
    if (portable) {
      log(`vendored cloudflared from ${c}`);
    } else if (rewriteElfInterpreter(dest, "/lib64/ld-linux-x86-64.so.2")) {
      log(`vendored cloudflared from ${c} (made portable)`);
    } else {
      log(`vendored cloudflared from ${c} — WARNING: it needs ${interpreter}, which the recipient's machine will not have`);
    }
    if (c === path.join(DIST, ".wsl-cloudflared")) rmrf(c);
    return;
  }

  log("no cloudflared available — packaging without a tunnel");
}

/**
 * Rewrite an ELF binary's program interpreter in place. Used to make a Homebrew
 * cloudflared shippable: its interpreter is `/home/linuxbrew/.linuxbrew/lib/ld.so`,
 * which the recipient will not have. Doing this by hand avoids a patchelf
 * dependency, and it is safe because PT_INTERP is a fixed-size NUL-padded string
 * and the new value is never longer than the old one on this path (checked first).
 */
function rewriteElfInterpreter(file, interpreter) {
  const fd = fs.openSync(file, "r+");
  try {
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) !== 64) return false;
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return false;
    const phoff = Number(head.readBigUInt64LE(0x20));
    const phentsize = head.readUInt16LE(0x36);
    const phnum = head.readUInt16LE(0x38);
    const table = Buffer.alloc(phentsize * phnum);
    if (fs.readSync(fd, table, 0, table.length, phoff) !== table.length) return false;
    for (let i = 0; i < phnum; i++) {
      const ph = table.subarray(i * phentsize, (i + 1) * phentsize);
      if (ph.readUInt32LE(0) !== 3) continue; // PT_INTERP
      const off = Number(ph.readBigUInt64LE(0x08));
      const size = Number(ph.readBigUInt64LE(0x20));
      const str = Buffer.alloc(size);
      fs.readSync(fd, str, 0, size, off);
      const old = str.toString("utf8").replace(/\0.*$/, "");
      if (Buffer.byteLength(interpreter) > size) return false;
      const padded = Buffer.concat([Buffer.from(interpreter, "utf8"), Buffer.alloc(size - Buffer.byteLength(interpreter), 0)]);
      fs.writeSync(fd, padded, 0, size, off);
      log(`rewrote ELF interpreter ${old} → ${interpreter}`);
      return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** The ELF program interpreter of a binary, or null when it is not ELF. */
function elfInterpreter(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) !== 64) return null;
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) return null;
    // e_phoff (offset 0x20, 8 bytes LE) and e_phentsize/e_phnum (0x36/0x38).
    const phoff = Number(head.readBigUInt64LE(0x20));
    const phentsize = head.readUInt16LE(0x36);
    const phnum = head.readUInt16LE(0x38);
    const table = Buffer.alloc(phentsize * phnum);
    if (fs.readSync(fd, table, 0, table.length, phoff) !== table.length) return null;
    for (let i = 0; i < phnum; i++) {
      const ph = table.subarray(i * phentsize, (i + 1) * phentsize);
      if (ph.readUInt32LE(0) !== 3) continue; // PT_INTERP
      const off = Number(ph.readBigUInt64LE(0x08));
      const size = Number(ph.readBigUInt64LE(0x20));
      const str = Buffer.alloc(size);
      fs.readSync(fd, str, 0, size, off);
      return str.toString("utf8").replace(/\0.*$/, "");
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const arg = process.argv[2];
  const target = arg ? arg.replace(/^--/, "") : hostPlatform();
  if (!NODE_TARGETS[target]) {
    fail(`unknown target: ${target}. Expected one of ${Object.keys(NODE_TARGETS).join(", ")}`);
  }

  const outDir = path.join(DIST, target);
  const appDir = "app";
  const runtimeDir = "runtime";
  const app = path.join(outDir, appDir);

  rmrf(outDir);
  fs.mkdirSync(app, { recursive: true });

  log(`target ${target}, node v${NODE_VERSION}`);
  await bundle(path.join(app, "index.mjs"));
  copyNodeModules(path.join(app, "node_modules"));
  copyUi(app);
  // The launcher that runs inside the package: bundled server + vendored
  // cloudflared + the bundled Node runtime, all found relative to itself.
  fs.copyFileSync(path.join(REPO, "bin", "pimcp-packaged.mjs"), path.join(outDir, "pimcp.mjs"));
  writeLaunchers(target, outDir, appDir, runtimeDir);
  downloadNode(target, runtimeDir);
  vendorCloudflared(target, path.join(outDir, "bin"));

  const size = (p) => {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      total += e.isDirectory() ? size(f) : fs.statSync(f).size;
    }
    return total;
  };
  log(`built ${outDir} (${(size(outDir) / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  process.stderr.write(`[package] ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
