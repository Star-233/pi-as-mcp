/**
 * Build seam for Pi's tool modules.
 *
 * src/pi-tools.ts cannot name this module statically: Pi's `exports` map has no
 * subpath for `dist/core/tools/*`, so a bare deep specifier fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED, and Node ignores tsconfig `paths`. Only a
 * runtime-resolved URL works in the checkout.
 *
 * The bundler is the opposite: it needs a literal specifier to follow. This file
 * is that literal, and tsconfig `paths` points it at the installed package.
 *
 * Nothing here is imported at development time — src/pi-tools.ts imports it only
 * through the define in scripts/package.mjs, which rewrites the specifier to this
 * file's path when bundling and leaves it alone otherwise. So the checkout keeps
 * resolving Pi the way it always did, and only the artifact gets the inlined copy.
 */

// @ts-expect-error - resolved by the tsconfig path alias, not by Node
import * as piTools from "@earendil-works/pi-coding-agent/dist/core/tools/index.js";

export const {
  createAllToolDefinitions,
  createTool,
  createToolDefinition,
  allToolNames,
} = piTools as Record<string, any>;
