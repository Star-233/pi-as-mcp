#!/usr/bin/env node
/**
 * supervise — run a command and make sure it dies when its parent dies.
 *
 * On Windows, killing the launcher does not necessarily reap the processes it
 * spawned: a hard kill (Task Manager, a signal that never reaches Node, a crashed
 * shell) can orphan the MCP server and — worse — an open Cloudflare tunnel. This
 * wrapper polls the parent pid and reaps the child when the parent disappears.
 *
 * Used internally by bin/pimcp.mjs. Not meant to be run by hand.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const parentIdx = argv.indexOf("--parent-pid");

if (parentIdx === -1 || sep === -1 || sep <= parentIdx + 1) {
  process.stderr.write("supervise: usage: supervise --parent-pid <pid> -- <command> [args…]\n");
  process.exit(2);
}

const parentPid = Number(argv[parentIdx + 1]);
const [command, ...args] = argv.slice(sep + 1);
if (!command) {
  process.stderr.write("supervise: no command given\n");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit" });

function parentIsAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but we may not signal it.
    return e && e.code === "EPERM";
  }
}

function killTree() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

const poll = setInterval(() => {
  if (!parentIsAlive()) {
    killTree();
    process.exit(0);
  }
}, 2000);
poll.unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(poll);
    killTree();
    setTimeout(() => process.exit(0), 300).unref();
  });
}

child.on("error", (e) => {
  process.stderr.write(`supervise: ${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  clearInterval(poll);
  process.exit(code ?? (signal ? 1 : 0));
});
