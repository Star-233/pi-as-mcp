/**
 * The agents-index probe: AGENTS.md stays an index.
 *
 * AGENTS.md must be at most 1000 tokens, estimated as a quarter of each ASCII
 * character plus one per other character, rounded up. Every file it links to
 * must exist, and every file under docs/agents must be linked from it.
 *
 * Usage: node scripts/agents-index-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const LIMIT = 1000;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`);
};

function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of text) (ch.codePointAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other);
}

const text = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
const tokens = estimateTokens(text);
check(`AGENTS.md is at most ${LIMIT} tokens (estimated ${tokens})`, tokens <= LIMIT);

const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/i.test(l));
check("AGENTS.md links to its detail files", links.length > 0);
for (const link of links) {
  check(`link exists: ${link}`, fs.existsSync(path.resolve(repo, link)));
}

const detailDir = path.join(repo, "docs", "agents");
for (const name of fs.readdirSync(detailDir)) {
  const rel = `docs/agents/${name}`;
  check(`${rel} is linked from AGENTS.md`, links.includes(rel));
}

process.exitCode = failures === 0 ? 0 : 1;
console.log(failures === 0 ? "\nall agents-index checks passed" : `\n${failures} check(s) failed`);
