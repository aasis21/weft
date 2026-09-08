// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveVersion } from "../src/version.mjs";
import { packageNativeRuntime } from "../../scripts/package-native-runtime.mjs";
import { nativeRuntimeDescriptor, NATIVE_TARGETS, nativeAssetName, requiredNativeFiles } from "../../scripts/native-runtime.mjs";

test("same-version update repairs a legacy JavaScript-only installation", {
  skip: !NATIVE_TARGETS.includes(`${process.platform}-${process.arch}`),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "weft-legacy-native-repair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, "release");
  const installDir = join(root, "installed");
  const skillDir = join(root, "skill");
  const home = join(root, "home");
  mkdirSync(installDir);
  mkdirSync(home);
  const bundleNames = ["extension.mjs", "relayServerProcess.mjs", "devtunnelHostWatchdog.mjs", "weft.mjs"];
  const payloads = new Map(bundleNames.map((name) => [name, Buffer.from(`same-version:${name}`)]));
  payloads.set("weft-skill.md", Buffer.from("fixture skill"));
  for (const name of packageNativeRuntime(release)) payloads.set(name, readFileSync(join(release, name)));
  for (const name of bundleNames) writeFileSync(join(installDir, name), payloads.get(name));
  writeFileSync(join(home, "pairing-sentinel"), "preserve pairing");
  const manifest = {
    schemaVersion: 1, version: resolveVersion(), nativeRuntime: nativeRuntimeDescriptor(),
    files: Object.fromEntries([...payloads].map(([name, bytes]) => [
      name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ])),
  };
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/release-manifest.json") {
      res.end(JSON.stringify(manifest));
    } else {
      const bytes = payloads.get(req.url?.slice(1));
      if (bytes) res.end(bytes);
      else res.writeHead(404).end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const target = `${process.platform}-${process.arch}`;
    assert.equal(existsSync(join(installDir, "node_modules", "node-pty")), false);
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "weft.mjs");
    const result = await promisify(execFile)(process.execPath, [cliPath, "update"], {
      env: {
        ...process.env, NO_COLOR: "1", WEFT_HOME: home,
        WEFT_INSTALL_BASE: `http://127.0.0.1:${server.address().port}`,
        WEFT_INSTALL_DIR: installDir, WEFT_SKILL_DIR: skillDir,
      },
      timeout: 15000,
    });
    assert.match(result.stdout, /Updated to Weft/);
    assert.equal(requests.filter((url) => url.startsWith("/native-runtime-")).length, 1);
    assert.ok(requests.includes(`/${nativeAssetName(target)}`));
    for (const name of requiredNativeFiles(target)) {
      assert.ok(existsSync(join(installDir, "node_modules", "node-pty", "prebuilds", target, name)));
    }
    assert.equal(readFileSync(join(home, "pairing-sentinel"), "utf8"), "preserve pairing");
    assert.equal(existsSync(join(installDir, ".install.lock")), false);
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
});
