#!/usr/bin/env node
/**
 * Vendor the two browser libraries the human UI needs into src/human/vendor/.
 *
 * The UI is a single self-contained page served from disk on 127.0.0.1. It must
 * work with no network at all, so nothing is loaded from a CDN. package.json
 * records the versions; this script copies the exact dist files into the tree so
 * a fresh checkout can serve the UI without running `npm install` first.
 *
 * Only .woff2 fonts are copied: every browser that supports KaTeX supports
 * woff2, and katex.min.css lists woff2 first in every `src:`, so the woff/ttf
 * siblings are never requested. That keeps ~20 files / ~300 KB instead of
 * 60 files / 1.2 MB.
 *
 * Usage: node scripts/vendor-ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src", "human", "vendor");
const nm = (p) => path.join(root, "node_modules", p);

const version = (pkg) =>
  JSON.parse(fs.readFileSync(nm(`${pkg}/package.json`), "utf8")).version;

const markedVersion = version("marked");
const katexVersion = version("katex");

// Wipe and rebuild: a stale file left behind by an older version would be served
// silently, and nothing else would ever notice.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });

const files = [
  [nm("marked/lib/marked.umd.js"), path.join(out, "marked.umd.js")],
  [nm("katex/dist/katex.min.js"), path.join(out, "katex.min.js")],
  [nm("katex/dist/katex.min.css"), path.join(out, "katex.min.css")],
];

for (const [from, to] of files) {
  if (!fs.existsSync(from)) {
    console.error(`missing ${path.relative(root, from)} - run \`npm install\` first`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
}

const fonts = fs
  .readdirSync(nm("katex/dist/fonts"))
  .filter((f) => f.endsWith(".woff2"))
  .sort();
for (const f of fonts) {
  fs.copyFileSync(nm(`katex/dist/fonts/${f}`), path.join(out, "fonts", f));
}

const bytes = (p) => fs.statSync(p).size;
const size = (p) => `${(bytes(p) / 1024).toFixed(0)} KB`;

const manifest = `# Vendored UI libraries

Do not edit these files. They are copied verbatim from \`node_modules\` by
\`npm run vendor-ui\` (\`scripts/vendor-ui.mjs\`). Re-run that script to update.

| File | Package | Version | Size |
|---|---|---|---|
| \`marked.umd.js\` | marked | ${markedVersion} | ${size(path.join(out, "marked.umd.js"))} |
| \`katex.min.js\` | katex | ${katexVersion} | ${size(path.join(out, "katex.min.js"))} |
| \`katex.min.css\` | katex | ${katexVersion} | ${size(path.join(out, "katex.min.css"))} |
| \`fonts/*.woff2\` | katex | ${katexVersion} | ${fonts.length} files |

Both are MIT licensed. \`marked\` is used to render agent messages as HTML;
\`katex\` renders the LaTeX that comes out of them.

Only \`.woff2\` is vendored, not \`.woff\`/\`.ttf\`. \`katex.min.css\` lists woff2
first in every \`src:\`, so a browser picks it and never requests the siblings.
`;
fs.writeFileSync(path.join(out, "README.md"), manifest);

const total =
  files.reduce((n, [, to]) => n + bytes(to), 0) +
  fonts.reduce((n, f) => n + bytes(path.join(out, "fonts", f)), 0);

console.log(
  `vendored marked ${markedVersion} + katex ${katexVersion} -> ` +
    `${path.relative(root, out)} (${3 + fonts.length} files, ${(total / 1024).toFixed(0)} KB)`,
);
