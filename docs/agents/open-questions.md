# Open questions

- The LICENSE is now the full Apache-2.0 text with `Copyright 2026 pi-as-mcp contributors`,
  replacing the 19-line stub that GitHub listed as "Other". Whether GitHub's licence detection
  now reports Apache-2.0 is only observable from the pushed repository, not locally.
- The project was promoted from the former `pi-mcp/` subdirectory to the repository root.
  Commits before that move and the `humanchat-final` tag name paths that no longer exist in
  the working tree; use `git log --follow` and `git show humanchat-final --stat`.
- `npm audit` reports one high-severity advisory (`brace-expansion`, quadratic-expansion DoS)
  that resolves into Pi's *nested* `node_modules`. It is left alone deliberately: `npm audit
  fix` would rewrite the lockfile and could move Pi itself, and the affected package is not
  shipped in `dist/` any more — the package keeps only Pi's wasm. Re-check it whenever Pi is
  upgraded.
