// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { generateReleaseManifest, REQUIRED_RELEASE_FILES } from "./generate-release-manifest.mjs";
import { nativeAssetName, NATIVE_TARGETS } from "./native-runtime.mjs";

const run = promisify(execFile);
const dist = fileURLToPath(new URL("../extension/dist/", import.meta.url));
const target = `${process.platform}-${process.arch}`;

test("bundled help and Copilot startup work without native assets; terminal fails explicitly", {
  skip: !existsSync(join(dist, "weft.mjs")) && "Build extension first",
  timeout: 30_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "weft-without-native-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WEFT_"))),
    HOME: directory, USERPROFILE: directory, WEFT_HOME: directory, NODE_PATH: "", NODE_OPTIONS: "",
  };
  copyFileSync(join(dist, "weft.mjs"), join(directory, "weft.mjs"));
  copyFileSync(join(dist, "extension.mjs"), join(directory, "extension.mjs"));
  for (const args of [["help"], ["start", "--help"]]) {
    const result = await run(process.execPath, [join(directory, "weft.mjs"), ...args], { cwd: directory, env, timeout: 10_000 });
    assert.match(result.stdout, /weft|WEFT/);
    assert.doesNotMatch(result.stderr, /Cannot find module.*node-pty|native module/i);
  }
  copyFileSync(fileURLToPath(new URL("../extension/scripts/sdk-stub-hook.mjs", import.meta.url)), join(directory, "sdk-stub-hook.mjs"));
  writeFileSync(join(directory, "extension-smoke.mjs"), `
import assert from "node:assert/strict";
import { register } from "node:module";
register(new URL("./sdk-stub-hook.mjs", import.meta.url));
await assert.rejects(import("./extension.mjs"), /WEFT_SDK_STUB_REACHED/);
`);
  await run(process.execPath, [join(directory, "extension-smoke.mjs")], { cwd: directory, env, timeout: 10_000 });
  const outfile = join(directory, "terminal-feature-smoke.mjs");
  await build({
    stdin: {
      contents: `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTerminalHost } from "./terminalHost.mjs";
const packageRequire = createRequire(import.meta.url);
assert.throws(() => packageRequire.resolve("node-pty"), { code: "MODULE_NOT_FOUND" });
const ordinary = createTerminalHost();
await ordinary.initialize();
assert.equal(ordinary.supportError, null, "ordinary Station must not attempt native loading");
await ordinary.stop();
const replies = [];
const authorized = createTerminalHost({ allowTerminal: true, send: async (message) => replies.push(message) });
await authorized.initialize();
assert.equal(authorized.supported, false);
await authorized.handle({ requestId: "missing-runtime", action: "open" });
assert.equal(replies.at(-1).msg.status, "error");
assert.match(replies.at(-1).msg.error, /runtime.*unavailable|requires Windows|unsupported/i);
await authorized.stop();
`,
      resolveDir: fileURLToPath(new URL("../extension/src/", import.meta.url)),
      loader: "js",
    },
    outfile, bundle: true, platform: "node", target: "node20", format: "esm", external: ["node-pty"], logLevel: "silent",
    banner: { js: "import {createRequire as runtimeRequire} from 'node:module'; const require = runtimeRequire(import.meta.url);" },
  });
  await run(process.execPath, [outfile], { cwd: directory, env, timeout: 10_000 });
  assert.equal(existsSync(join(directory, "node_modules")), false);
});

test("hosted bootstrap, installed updater and local install deliver an isolated working PTY transactionally", {
  skip: !NATIVE_TARGETS.includes(target) ? "No vendor prebuild for this platform" :
    !existsSync(join(dist, "weft.mjs")) ? "Build extension first; native distribution CI runs this after build" : false,
  timeout: 180_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "weft-native-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = join(directory, "release");
  const installed = join(directory, "installed");
  const home = join(directory, "home");
  mkdirSync(release);
  mkdirSync(home);
  const unrelatedModule = join(installed, "node_modules", "unrelated-package");
  mkdirSync(unrelatedModule, { recursive: true });
  writeFileSync(join(unrelatedModule, "sentinel"), "preserve unrelated node_modules");
  for (const name of REQUIRED_RELEASE_FILES) {
    if (name === "weft-skill.md") writeFileSync(join(release, name), "fixture skill");
    else copyFileSync(join(dist, name), join(release, name));
  }
  const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const { manifest } = generateReleaseManifest(release, version);
  const config = join(home, "weft.config.json");
  const pairing = join(home, "pairing-sentinel.json");
  writeFileSync(config, '{"fixture":"preserve-config"}');
  writeFileSync(pairing, '{"fixture":"preserve-pairing"}');
  const requests = [];
  let corruptNative = false;
  const server = createServer((request, response) => {
    requests.push(request.url);
    const name = request.url?.slice(1);
    if (name === "release-manifest.json") {
      response.end(JSON.stringify(manifest));
    } else if (REQUIRED_RELEASE_FILES.includes(name)) {
      const bytes = readFileSync(join(release, name));
      if (corruptNative && name === nativeAssetName(target)) bytes[bytes.length - 1] ^= 1;
      response.end(bytes);
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, WEFT_HOME: home,
    WEFT_INSTALL_DIR: installed, WEFT_SKILL_DIR: join(directory, "skill"),
    WEFT_INSTALL_BASE: `http://127.0.0.1:${server.address().port}`,
    NODE_PATH: "", NODE_OPTIONS: "",
  };
  const bootstrap = join(directory, "bootstrap.mjs");
  copyFileSync(join(dist, "weft.mjs"), bootstrap);
  await run(process.execPath, [bootstrap, "install"], { cwd: directory, env, timeout: 30_000 });
  const runtimeFile = join(installed, "node_modules", "node-pty", "prebuilds", target, target.startsWith("win32") ? "conpty.node" : "pty.node");
  assert.ok(existsSync(runtimeFile), "bootstrap must install native binaries, not just bundled JS");
  assert.ok(requests.includes(`/${nativeAssetName(target)}`));
  assert.equal(requests.filter((path) => path.startsWith("/native-runtime-")).length, 1, "download only the selected architecture");
  // The previous JS-only updater can leave the new CLI installed without its runtime.
  rmSync(join(installed, "node_modules", "node-pty"), { recursive: true });
  const repaired = await run(process.execPath, [join(installed, "weft.mjs"), "update"], { cwd: directory, env, timeout: 30_000 });
  assert.ok(existsSync(runtimeFile), "a same-version update must repair missing native assets");
  assert.ok(repaired.stdout.includes(`Updated to Weft ${version}`));
  const originalRuntime = readFileSync(runtimeFile);
  const originalBundle = readFileSync(join(installed, "weft.mjs"));
  const lock = join(installed, ".install.lock");
  writeFileSync(lock, "concurrent installer fixture");
  await assert.rejects(run(process.execPath, [join(installed, "weft.mjs"), "update"], { cwd: directory, env, timeout: 30_000 }), /Another Weft install\/update/);
  assert.equal(readFileSync(lock, "utf8"), "concurrent installer fixture");
  rmSync(lock);
  const nativeDescriptor = manifest.nativeRuntime;
  delete manifest.nativeRuntime;
  await assert.rejects(run(process.execPath, [join(installed, "weft.mjs"), "update"], { cwd: directory, env, timeout: 30_000 }), /missing a compatible native terminal runtime/);
  manifest.nativeRuntime = nativeDescriptor;
  corruptNative = true;
  await assert.rejects(run(process.execPath, [join(installed, "weft.mjs"), "update"], { cwd: directory, env, timeout: 30_000 }), /integrity check failed/i);
  assert.deepEqual(readFileSync(runtimeFile), originalRuntime);
  assert.deepEqual(readFileSync(join(installed, "weft.mjs")), originalBundle);
  assert.equal(existsSync(lock), false);
  for (const path of [installed, join(installed, "node_modules")]) {
    assert.ok(readdirSync(path).every((name) => !name.endsWith(".stage") && !name.endsWith(".backup")));
  }
  corruptNative = false;
  await run(process.execPath, [join(installed, "weft.mjs"), "update"], { cwd: directory, env, timeout: 30_000 });
  assert.equal(readFileSync(config, "utf8"), '{"fixture":"preserve-config"}');
  assert.equal(readFileSync(pairing, "utf8"), '{"fixture":"preserve-pairing"}');
  assert.equal(readFileSync(join(unrelatedModule, "sentinel"), "utf8"), "preserve unrelated node_modules");
  await run(process.execPath, [bootstrap, "install", "--from", dist, "--skill", join(release, "weft-skill.md")], { cwd: directory, env, timeout: 30_000 });
  const smoke = join(installed, "smoke.mjs");
  copyFileSync(fileURLToPath(new URL("./native-runtime-smoke.mjs", import.meta.url)), smoke);
  const result = await run(process.execPath, [smoke], { cwd: installed, env, timeout: 75_000 });
  assert.match(result.stdout, /isolated native PTY spawn\/input\/output\/resize\/close OK/);
  assert.equal(readFileSync(join(unrelatedModule, "sentinel"), "utf8"), "preserve unrelated node_modules");
});
