// SPDX-License-Identifier: Apache-2.0
//
// Single accessor for the running Weft version. Two runtime shapes must both work:
//
//   1. Bundled (installed): esbuild replaces the `__WEFT_VERSION__` token below with the value read
//      from the repo-root VERSION file at build time (see esbuild.config.mjs `define`). The shipped
//      dist/extension.mjs and dist/weft.mjs carry the version inline — no VERSION file is installed
//      alongside them, so this is the only path that works once installed.
//   2. Unbundled (in-repo): `weft.ps1`/`weft.sh` run bin/weft.mjs straight from src, and the tests
//      import these modules directly. There is no esbuild `define`, so `__WEFT_VERSION__` is an
//      undefined identifier — the `typeof` guard avoids a ReferenceError and we fall back to reading
//      the repo-root VERSION file by walking up from this module.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_VERSION = typeof __WEFT_VERSION__ === "string" ? __WEFT_VERSION__ : null;

let cached = null;

/** Resolve Weft's version: the value baked in at bundle time, else the repo-root VERSION file. */
export function resolveVersion() {
  if (BUILD_VERSION) return BUILD_VERSION;
  if (cached) return cached;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "VERSION");
      if (existsSync(candidate)) {
        cached = readFileSync(candidate, "utf8").trim();
        return cached;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to the unknown sentinel
  }
  cached = "0.0.0";
  return cached;
}
