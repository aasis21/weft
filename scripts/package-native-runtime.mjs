// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeNativeRuntime, NATIVE_JS_FILES, NATIVE_TARGETS, NODE_PTY_VERSION, nativeAssetName, requiredNativeFiles, sha256 } from "./native-runtime.mjs";

const require = createRequire(import.meta.url);

export function packageNativeRuntime(directory, source = dirname(require.resolve("node-pty/package.json"))) {
  const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (metadata.version !== NODE_PTY_VERSION) throw new Error(`Expected node-pty ${NODE_PTY_VERSION}; found ${metadata.version}.`);
  const common = [];
  function add(path, data, mode = 0o644) {
    common.push({ path, mode, data: data.toString("base64"), sha256: sha256(data) });
  }
  for (const path of NATIVE_JS_FILES) add(path, readFileSync(join(source, path)));
  // node-addon-api is a build-time header dependency, not required by lib/*.js.
  // Never ship node-gyp/install hooks or source, tests, maps, headers and PDBs.
  add("package.json", Buffer.from(JSON.stringify({ name: "node-pty", version: NODE_PTY_VERSION, main: "./lib/index.js", license: "MIT" }) + "\n"));
  add("LICENSE", readFileSync(join(source, "LICENSE")));
  add("LICENSE-winpty", readFileSync(join(source, "deps", "winpty", "LICENSE")));
  mkdirSync(directory, { recursive: true });
  for (const target of NATIVE_TARGETS) {
    const files = [...common];
    for (const name of requiredNativeFiles(target)) {
      const path = `prebuilds/${target}/${name}`;
      const data = readFileSync(join(source, path));
      files.push({ path, mode: name === "spawn-helper" ? 0o755 : 0o644, data: data.toString("base64"), sha256: sha256(data) });
    }
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, target, nodePtyVersion: NODE_PTY_VERSION, files }) + "\n");
    decodeNativeRuntime(bytes, target);
    writeFileSync(join(directory, nativeAssetName(target)), bytes);
  }
  return NATIVE_TARGETS.map(nativeAssetName);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(packageNativeRuntime(resolve(process.argv[2] ?? "extension/dist")).join("\n"));
}
