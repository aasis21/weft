// Guards the one failure mode that is INVISIBLE in a repo checkout and fatal on every installed
// machine: a module under src/ that spawns a sibling file (resolved from its own import.meta.url)
// which esbuild never emits and the installers never copy. In dev the sibling exists because the
// whole source tree is on disk; installed, the main bundle is a single inlined file and
// "./thing.mjs" next to it resolves to nothing -> ERR_MODULE_NOT_FOUND at spawn time.
//
// That is exactly how devtunnelHostWatchdog.mjs shipped broken: the relay simply "failed to start"
// on installed machines with no hint as to why, while `npm test` and a source run were both green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RELEASE_BUNDLE_NAMES } from "../../scripts/release-layout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, "..");
const srcDir = path.join(extensionRoot, "src");

// Matches the `new URL("./x.mjs", import.meta.url)` form used to resolve a spawnable sibling.
// Only .mjs siblings matter — those are the ones handed to spawn/fork as a script path.
const SIBLING_URL = /new URL\(\s*["']\.\/([A-Za-z0-9_.-]+\.mjs)["']\s*,\s*import\.meta\.url\s*\)/g;

function siblingsReferencedInSrc() {
  const found = new Map();
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const text = readFileSync(path.join(srcDir, entry.name), "utf8");
    for (const match of text.matchAll(SIBLING_URL)) {
      const sibling = match[1];
      if (!found.has(sibling)) found.set(sibling, []);
      found.get(sibling).push(entry.name);
    }
  }
  return found;
}

test("every spawnable sibling under src/ is emitted by esbuild and shipped by the installers", () => {
  const siblings = siblingsReferencedInSrc();
  assert.ok(
    siblings.size > 0,
    "found no sibling-file spawns at all — the detection regex has probably drifted from the source",
  );

  const emitted = new Set(RELEASE_BUNDLE_NAMES);
  const shipped = new Set(RELEASE_BUNDLE_NAMES);

  for (const [sibling, referencedBy] of siblings) {
    const where = referencedBy.join(", ");
    assert.ok(
      emitted.has(sibling),
      `src/${where} spawns "./${sibling}" but esbuild never emits it — add it to SIBLING_ENTRYPOINTS ` +
        `in extension/esbuild.config.mjs, or the spawn dies with ERR_MODULE_NOT_FOUND once installed.`,
    );
    assert.ok(
      shipped.has(sibling),
      `src/${where} spawns "./${sibling}" but it is not in the centralized release layout — ` +
        "`weft install` / `weft update` would never download it.",
    );
  }
});

test("both ship scripts stage the centralized payload and verify its manifest", () => {
  const repoRoot = path.resolve(extensionRoot, "..");
  for (const script of ["ship.ps1", "ship.sh"]) {
    const text = readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(text, /stage-release-payload\.mjs/);
    assert.match(text, /generate-release-manifest\.mjs/);
    assert.match(text, /verify-release-manifest\.mjs/);
  }
});

test("the active runtime is built and shipped beside the dormant bootstrap", () => {
  const esbuildConfig = readFileSync(path.join(extensionRoot, "esbuild.config.mjs"), "utf8");
  assert.match(esbuildConfig, /entryPoints:\s*\["src\/activeRuntime\.mjs"\]/);
  assert.match(esbuildConfig, /activeRuntimeOutfile\s*=\s*"dist\/activeRuntime\.mjs"/);
  assert.ok(RELEASE_BUNDLE_NAMES.includes("activeRuntime.mjs"));
});
