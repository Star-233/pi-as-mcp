/**
 * Build-time constants injected by scripts/package.mjs.
 *
 * There are none today: the bundler reaches the packaged build through a source
 * rewrite (see the `pi-tools-literal` plugin) rather than through `define`, so a
 * literal can survive into the bundle. This file exists so that adding one is a
 * deliberate act — an undeclared global fails typecheck here rather than at
 * runtime on the recipient's machine.
 */
