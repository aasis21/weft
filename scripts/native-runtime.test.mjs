// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { packageNativeRuntime } from "./package-native-runtime.mjs";
import { decodeNativeRuntime, fetchNativeRuntime, MAX_RUNTIME_BYTES, NATIVE_TARGETS, nativeAssetName, nativeRuntimeDescriptor, sha256, stageNativeRuntime } from "./native-runtime.mjs";
import { generateReleaseManifest, REQUIRED_RELEASE_FILES } from "./generate-release-manifest.mjs";
import { verifyReleaseManifest } from "./verify-release-manifest.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "weft-native-distribution-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  packageNativeRuntime(directory);
  return directory;
}

test("packages only runtime JS, licenses and vendor binaries for all four architectures", (t) => {
  const directory = fixture(t);
  for (const target of NATIVE_TARGETS) {
    const bytes = readFileSync(join(directory, nativeAssetName(target)));
    const files = decodeNativeRuntime(bytes, target);
    assert.ok(bytes.length < 5 * 1024 * 1024, `${target} runtime should remain small`);
    assert.ok(files.some((file) => file.path.endsWith(".node")));
    assert.ok(files.every((file) => !/\.(pdb|map|test\.js)$/.test(file.path)));
    assert.ok(files.every((file) => !file.path.includes("node-addon-api")));
    if (target.startsWith("win32")) {
      assert.ok(files.some((file) => file.path.endsWith("/conpty/OpenConsole.exe")));
      assert.ok(files.some((file) => file.path.endsWith("/winpty.dll")));
    } else {
      assert.equal(files.find((file) => file.path.endsWith("/spawn-helper")).mode, 0o755);
    }
  }
});

test("native assets are required and checksum-covered by every release manifest", (t) => {
  const directory = fixture(t);
  for (const name of REQUIRED_RELEASE_FILES.filter((name) => !name.startsWith("native-runtime-"))) {
    writeFileSync(join(directory, name), "bundle");
  }
  const { manifest } = generateReleaseManifest(directory, "1.2.3");
  assert.deepEqual(manifest.nativeRuntime, nativeRuntimeDescriptor());
  assert.deepEqual(verifyReleaseManifest(directory), manifest);
  for (const target of NATIVE_TARGETS) {
    const name = nativeAssetName(target);
    const bytes = readFileSync(join(directory, name));
    assert.equal(manifest.files[name].sha256, sha256(bytes));
    assert.equal(manifest.files[name].bytes, bytes.length);
  }
  rmSync(join(directory, nativeAssetName("win32-arm64")));
  assert.throws(() => verifyReleaseManifest(directory), /ENOENT/);
  assert.throws(() => generateReleaseManifest(directory, "1.2.3"), /Missing required release payload/);
});

test("runtime rejects traversal, links, duplicate paths, corruption, missing and incompatible files", (t) => {
  const directory = fixture(t);
  const bytes = readFileSync(join(directory, nativeAssetName("win32-x64")));
  const mutate = (callback) => {
    const payload = JSON.parse(bytes);
    callback(payload);
    return Buffer.from(JSON.stringify(payload));
  };
  for (const path of ["../escape", "/absolute", "C:\\escape", "lib/../../escape.js", "lib/CON.js", "lib/CON.js:stream", "prebuilds/win32-arm64/conpty.node"]) {
    assert.throws(() => decodeNativeRuntime(mutate((payload) => { payload.files[0].path = path; }), "win32-x64"), /Unsafe/);
  }
  assert.throws(() => decodeNativeRuntime(mutate((payload) => { payload.files.push(payload.files[0]); }), "win32-x64"), /Unsafe/);
  assert.throws(() => decodeNativeRuntime(mutate((payload) => { payload.files[0].data = "YmFk"; }), "win32-x64"), /integrity/);
  assert.throws(() => decodeNativeRuntime(mutate((payload) => { payload.files = []; }), "win32-x64"), /Missing native/);
  assert.throws(() => decodeNativeRuntime(mutate((payload) => { payload.nodePtyVersion = "0.0.0"; }), "win32-x64"), /incompatible/);
  assert.throws(() => decodeNativeRuntime(bytes, "win32-arm64"), /incompatible/);
  assert.throws(() => decodeNativeRuntime(bytes, "linux-x64"), /unsupported/);
  assert.throws(() => decodeNativeRuntime(Buffer.alloc(MAX_RUNTIME_BYTES + 1), "win32-x64"), /size limit/);
});

test("staging fails closed for a supported platform's missing manifest runtime", async (t) => {
  const directory = fixture(t);
  await assert.rejects(stageNativeRuntime({ manifest: {}, target: "win32-x64", stageDir: join(directory, "stage") }), /missing a compatible native/);
  assert.equal(await stageNativeRuntime({ manifest: {}, target: "linux-x64", stageDir: join(directory, "stage") }), false);
});

test("downloads enforce exact bytes and SHA-256 before extraction", async (t) => {
  const directory = fixture(t);
  const data = readFileSync(join(directory, nativeAssetName("win32-x64")));
  const server = createServer((_request, response) => response.end(data));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/native.json`;
  const metadata = { bytes: data.length, sha256: sha256(data) };
  assert.deepEqual(await fetchNativeRuntime(url, metadata), data);
  await assert.rejects(fetchNativeRuntime(url, { ...metadata, bytes: 1 }), /exceeds manifest size/);
  await assert.rejects(fetchNativeRuntime(url, { ...metadata, bytes: data.length + 1 }), /integrity/);
  await assert.rejects(fetchNativeRuntime(url, { ...metadata, sha256: "0".repeat(64) }), /integrity/);
  await assert.rejects(fetchNativeRuntime(url, { ...metadata, bytes: MAX_RUNTIME_BYTES + 1 }), /size\/checksum/);
});

test("isolated packaged native PTY spawns, accepts input, returns output, resizes and closes", {
  skip: !NATIVE_TARGETS.includes(`${process.platform}-${process.arch}`) && "No vendor prebuild exists for this platform",
  timeout: 90_000,
}, async (t) => {
  const directory = fixture(t);
  const installed = join(directory, "installed");
  await stageNativeRuntime({ fromDir: directory, stageDir: join(installed, "node_modules", "node-pty") });
  const smoke = join(installed, "smoke.mjs");
  writeFileSync(smoke, readFileSync(new URL("./native-runtime-smoke.mjs", import.meta.url)));
  const result = spawnSync(process.execPath, [smoke], {
    cwd: installed, encoding: "utf8", timeout: 75_000,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /isolated native PTY spawn\/input\/output\/resize\/close OK/);
});
