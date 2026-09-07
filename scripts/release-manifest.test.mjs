// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReleaseManifest, REQUIRED_RELEASE_FILES } from "./generate-release-manifest.mjs";

test("release manifest contains deterministic hashes and optional versioned APK metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-release-"));
  try {
    for (const name of REQUIRED_RELEASE_FILES) writeFileSync(join(dir, name), `payload:${name}`);
    writeFileSync(join(dir, "weft-1.2.3.apk"), "apk");

    const { manifest, output } = generateReleaseManifest(dir, "1.2.3");

    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.files["weft.mjs"].bytes, Buffer.byteLength("payload:weft.mjs"));
    assert.match(manifest.files["weft.mjs"].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.files["weft-1.2.3.apk"].bytes, 3);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).files, manifest.files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release manifest refuses an incomplete installer payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-release-"));
  try {
    assert.throws(() => generateReleaseManifest(dir, "1.2.3"), /Missing required release payload/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release manifest rejects an unsafe version string", () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-release-"));
  try {
    assert.throws(() => generateReleaseManifest(dir, "../latest"), /Invalid release version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
