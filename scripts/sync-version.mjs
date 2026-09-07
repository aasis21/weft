#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for Weft's version is the repo-root `VERSION` file. This script stamps
// that value into every workspace package.json and package-lock entry so `npm`,
// the Vite build (mobile — reads its own package.json), and the esbuild bundles stay in lockstep.
//
//   node scripts/sync-version.mjs          # write VERSION into all package.json files
//   node scripts/sync-version.mjs --check  # exit 1 if any package.json is out of sync (CI guard)
//
// The bundled extension/CLI don't read package.json at runtime — esbuild bakes VERSION in via a
// build-time `define` (see extension/esbuild.config.mjs) — so this script only keeps the manifests
// honest; it is not on the runtime path.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();

if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`sync-version: VERSION file holds an invalid semver: "${version}"`);
  process.exit(1);
}

const manifests = [
  "package.json",
  "shared/package.json",
  "extension/package.json",
  "mobile/package.json",
];
const lockPath = join(repoRoot, "package-lock.json");
const lockPackageKeys = ["", "extension", "mobile", "shared"];

const check = process.argv.includes("--check");
let drift = false;

for (const rel of manifests) {
  const path = join(repoRoot, rel);
  const raw = readFileSync(path, "utf8");
  const pkg = JSON.parse(raw);
  if (pkg.version === version) continue;
  if (check) {
    console.error(`sync-version: ${rel} is ${pkg.version}, expected ${version}`);
    drift = true;
    continue;
  }
  // Rewrite only the version line to preserve formatting/ordering/trailing newline.
  const updated = raw.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  writeFileSync(path, updated);
  console.log(`sync-version: ${rel} -> ${version}`);
}

const lockRaw = readFileSync(lockPath, "utf8");
const lock = JSON.parse(lockRaw);
const staleLockEntries = lockPackageKeys.filter((key) => lock.packages?.[key]?.version !== version);
if (lock.version !== version) staleLockEntries.unshift("<root>");
if (staleLockEntries.length > 0) {
  if (check) {
    console.error(`sync-version: package-lock.json has stale version entries: ${staleLockEntries.join(", ")}`);
    drift = true;
  } else {
    lock.version = version;
    for (const key of lockPackageKeys) {
      if (!lock.packages?.[key]) throw new Error(`sync-version: package-lock.json is missing packages["${key}"]`);
      lock.packages[key].version = version;
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`sync-version: package-lock.json -> ${version}`);
  }
}

if (check && drift) {
  console.error("sync-version: run `npm run sync-version` to fix.");
  process.exit(1);
}
if (check) console.log(`sync-version: all manifests at ${version}`);
