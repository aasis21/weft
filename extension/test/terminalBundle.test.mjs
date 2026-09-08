// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";

test("isolated bundles work without native assets and fail only explicit terminal use", { timeout: 30_000 }, async (t) => {
  const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(join(tmpdir(), "weft-terminal-no-native-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await build({
    entryPoints: {
      weft: join(extension, "bin", "weft.mjs"),
      terminalHost: join(extension, "src", "terminalHost.mjs"),
      listener: join(extension, "src", "listener.mjs"),
      shared: join(extension, "..", "shared", "index.mjs"),
      extension: join(extension, "src", "extension.mjs"),
    },
    outdir: dir, outExtension: { ".js": ".mjs" },
    bundle: true, platform: "node", target: "node20", format: "esm",
    external: ["node-pty"],
    banner: { js: "import { createRequire as makeRequire } from 'node:module'; const require = makeRequire(import.meta.url);" },
    plugins: [{
      name: "terminal-test-sdk",
      setup(plugin) {
        plugin.onResolve({ filter: /^@github\/copilot-sdk\/extension$/ }, () => ({ path: "sdk", namespace: "terminal-test" }));
        plugin.onLoad({ filter: /^sdk$/, namespace: "terminal-test" }, () => ({
          contents: 'export async function joinSession() { throw new Error("TERMINAL_TEST_SDK_REACHED"); }',
        }));
      },
    }],
    logLevel: "silent",
  });
  assert.equal(existsSync(join(dir, "node_modules")), false);
  const env = { ...process.env, NODE_PATH: "", WEFT_HOME: join(dir, "home") };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("WEFT_") && key !== "WEFT_HOME") || key === "NODE_OPTIONS") delete env[key];
  }
  const run = promisify(execFile);
  const help = await run(process.execPath, [join(dir, "weft.mjs"), "help"], { cwd: dir, env, timeout: 10000 });
  assert.match(help.stdout, /Enabled by default/);
  assert.match(help.stdout, /"terminal": \{"enabled": false\}/);
  const startHelp = await run(process.execPath, [join(dir, "weft.mjs"), "start", "--help"], { cwd: dir, env, timeout: 10000 });
  assert.match(startHelp.stdout, /NOT a sandbox/);
  await run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const root = process.cwd();
    const moduleUrl = pathToFileURL(join(root, "terminalHost.mjs")).href;
    assert.throws(() => createRequire(moduleUrl).resolve("node-pty"), { code: "MODULE_NOT_FOUND" });
    const { createTerminalHost } = await import(moduleUrl);
    let nativeLoads = 0;
    const disabled = createTerminalHost({ loadRuntime: async () => { nativeLoads++; throw new Error("must not load"); } });
    await disabled.initialize();
    assert.equal(nativeLoads, 0);
    assert.equal(disabled.supported, false);
    await disabled.stop();

    const { createListener } = await import(pathToFileURL(join(root, "listener.mjs")).href);
    const { generateKeyPair, createLocalTransport } = await import(pathToFileURL(join(root, "shared.mjs")).href);
    const station = createListener({
      transport: createLocalTransport({ channelId: "no-native-test" }),
      transportDescriptor: { kind: "local", channelId: "no-native-test" },
      keyPair: await generateKeyPair(), channelId: "no-native-test", deviceId: "test-device",
      connectionsHome: process.env.WEFT_HOME,
    });
    try { await station.start(); } finally { await station.stop(); }

    const messages = [];
    const authorized = createTerminalHost({ allowTerminal: true, send: async (message) => messages.push(message) });
    try {
      await authorized.initialize();
      assert.equal(authorized.supported, false);
      await authorized.handle({ requestId: "missing-native", action: "open" });
      assert.equal(messages.at(-1).msg.status, "error");
      assert.match(messages.at(-1).msg.error, /runtime is unavailable|requires Windows/);
      if (process.platform === "win32") assert.match(messages.at(-1).msg.error, /weft update.*once more/);
    } finally { await authorized.stop(); }

    await assert.rejects(import(pathToFileURL(join(root, "extension.mjs")).href), /TERMINAL_TEST_SDK_REACHED/);
  `], { cwd: dir, env, timeout: 15000 });
});
