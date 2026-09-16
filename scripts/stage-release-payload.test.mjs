// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_TARGETS, nativeAssetName } from "./native-runtime.mjs";
import { RELEASE_BUNDLE_NAMES, RELEASE_SKILL_NAME } from "./release-layout.mjs";
import { stageReleasePayload } from "./stage-release-payload.mjs";

test("release staging copies every centralized bundle, native envelope, and skill", (t) => {
  const root = mkdtempSync(join(tmpdir(), "weft-stage-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundleDir = join(root, "bundles");
  const releaseDir = join(root, "release");
  const skillFile = join(root, "SKILL.md");
  const names = [...RELEASE_BUNDLE_NAMES, ...NATIVE_TARGETS.map(nativeAssetName)];
  mkdirSync(bundleDir);
  for (const name of names) {
    const path = join(bundleDir, name);
    writeFileSync(path, `payload:${name}`);
  }
  writeFileSync(skillFile, "skill payload");

  stageReleasePayload({ bundleDir, releaseDir, skillFile });

  for (const name of names) {
    assert.equal(readFileSync(join(releaseDir, name), "utf8"), `payload:${name}`);
  }
  assert.equal(readFileSync(join(releaseDir, RELEASE_SKILL_NAME), "utf8"), "skill payload");
});
