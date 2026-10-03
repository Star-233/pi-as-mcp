# Vendored UI libraries

Do not edit these files. They are copied verbatim from `node_modules` by
`npm run vendor-ui` (`scripts/vendor-ui.mjs`). Re-run that script to update.

| File | Package | Version | Size |
|---|---|---|---|
| `marked.umd.js` | marked | 18.0.14 | 46 KB |
| `katex.min.js` | katex | 0.19.0 | 266 KB |
| `katex.min.css` | katex | 0.19.0 | 24 KB |
| `fonts/*.woff2` | katex | 0.19.0 | 20 files |

Both are MIT licensed. `marked` is used to render agent messages as HTML;
`katex` renders the LaTeX that comes out of them.

Only `.woff2` is vendored, not `.woff`/`.ttf`. `katex.min.css` lists woff2
first in every `src:`, so a browser picks it and never requests the siblings.
