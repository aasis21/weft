#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS, nativeAssetName } from "./native-runtime.mjs";
import { RELEASE_BUNDLE_NAMES, RELEASE_SKILL_NAME } from "./release-layout.mjs";

export function stageReleasePayload({ bundleDir, releaseDir, skillFile }) {
  mkdirSync(releaseDir, { recursive: true });
  for (const name of [...RELEASE_BUNDLE_NAMES, ...NATIVE_TARGETS.map(nativeAssetName)]) {
    copyFileSync(join(bundleDir, name), join(releaseDir, name));
  }
  copyFileSync(skillFile, join(releaseDir, RELEASE_SKILL_NAME));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , bundleDir, releaseDir, skillFile] = process.argv;
  if (!bundleDir || !releaseDir || !skillFile) {
    throw new Error("Usage: stage-release-payload.mjs <bundle-dir> <release-dir> <skill-file>");
  }
  stageReleasePayload({
    bundleDir: resolve(bundleDir),
    releaseDir: resolve(releaseDir),
    skillFile: resolve(skillFile),
  });
}
