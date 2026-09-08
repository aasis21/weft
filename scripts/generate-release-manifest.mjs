#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeNativeRuntime, NATIVE_TARGETS, nativeAssetName, nativeRuntimeDescriptor } from "./native-runtime.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REQUIRED_RELEASE_FILES = [
  "extension.mjs",
  "relayServerProcess.mjs",
  "devtunnelHostWatchdog.mjs",
  "weft.mjs",
  "weft-skill.md",
  ...NATIVE_TARGETS.map(nativeAssetName),
];

export function generateReleaseManifest(directory, version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const names = [...REQUIRED_RELEASE_FILES, `weft-${version}.apk`];
  const files = {};
  for (const name of names) {
    const path = join(directory, name);
    if (!existsSync(path)) {
      if (REQUIRED_RELEASE_FILES.includes(name)) throw new Error(`Missing required release payload: ${path}`);
      continue;
    }
    const contents = readFileSync(path);
    const nativeTarget = NATIVE_TARGETS.find((target) => nativeAssetName(target) === name);
    if (nativeTarget) decodeNativeRuntime(contents, nativeTarget);
    files[name] = {
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }

  const manifest = {
    schemaVersion: 1,
    version,
    generatedAt: new Date().toISOString(),
    files,
    nativeRuntime: nativeRuntimeDescriptor(),
  };
  const output = join(directory, "release-manifest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(root, "mobile", "public"));
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const { manifest, output } = generateReleaseManifest(directory, version);
  console.log(`release manifest: ${basename(output)} (${Object.keys(manifest.files).length} files, v${version})`);
}
