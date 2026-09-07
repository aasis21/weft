// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./sync-version.mjs", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "weft-sync-version-"));
  mkdirSync(join(root, "scripts"));
  cpSync(script, join(root, "scripts", "sync-version.mjs"));
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  for (const directory of ["", "shared", "extension", "mobile"]) {
    if (directory) mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, "package.json"), `${JSON.stringify({ version: "0.0.1" }, null, 2)}\n`);
  }
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "weft",
    version: "0.0.1",
    lockfileVersion: 3,
    packages: {
      "": { version: "0.0.1" },
      shared: { version: "0.0.1" },
      extension: { version: "0.0.1" },
      mobile: { version: "0.0.1" },
    },
  }, null, 2)}\n`);
  return root;
}

test("sync-version updates manifests and package-lock workspace entries", () => {
  const root = createFixture();
  try {
    execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs")]);
    for (const manifest of ["package.json", "shared/package.json", "extension/package.json", "mobile/package.json"]) {
      assert.equal(JSON.parse(readFileSync(join(root, manifest), "utf8")).version, "1.2.3");
    }
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.version, "1.2.3");
    for (const key of ["", "shared", "extension", "mobile"]) {
      assert.equal(lock.packages[key].version, "1.2.3");
    }
    assert.doesNotThrow(() => execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs"), "--check"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync-version check rejects stale package-lock entries", () => {
  const root = createFixture();
  try {
    assert.throws(
      () => execFileSync(process.execPath, [join(root, "scripts", "sync-version.mjs"), "--check"], { stdio: "pipe" }),
      /Command failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
