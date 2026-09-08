// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NODE_PTY_VERSION = "1.1.0";
export const NATIVE_TARGETS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64"];
export const NATIVE_JS_FILES = [
  "conpty_console_list_agent.js", "eventEmitter2.js", "index.js", "interfaces.js",
  "terminal.js", "types.js", "unixTerminal.js", "utils.js", "windowsConoutConnection.js",
  "windowsPtyAgent.js", "windowsTerminal.js", "shared/conout.js", "worker/conoutSocketWorker.js",
].map((name) => `lib/${name}`);
export const MAX_RUNTIME_BYTES = 16 * 1024 * 1024;
export const nativeAssetName = (target) => `native-runtime-${target}.json`;
export const nativeRuntimeDescriptor = () => ({
  schemaVersion: 1,
  nodePtyVersion: NODE_PTY_VERSION,
  targets: Object.fromEntries(NATIVE_TARGETS.map((target) => [target, nativeAssetName(target)])),
});
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function requiredNativeFiles(target) {
  return target.startsWith("win32-")
    ? ["conpty.node", "conpty_console_list.node", "pty.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"]
    : ["pty.node", "spawn-helper"];
}

function validRuntimePath(path, target) {
  if (path.length > 240 || path.split("/").some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  return path === "package.json" || path === "LICENSE" || path === "LICENSE-winpty" ||
    NATIVE_JS_FILES.includes(path) ||
    requiredNativeFiles(target).some((name) => path === `prebuilds/${target}/${name}`);
}

// A bounded file envelope rather than a tar extractor: no links, traversal, implicit
// executable modes, or archive extensions can introduce files outside this package.
export function decodeNativeRuntime(bytes, target) {
  if (!NATIVE_TARGETS.includes(target)) throw new Error(`Native terminal runtime is unsupported on ${target}.`);
  if (bytes.length > MAX_RUNTIME_BYTES) throw new Error("Native terminal runtime exceeds the size limit.");
  const payload = JSON.parse(bytes.toString("utf8"));
  if (payload?.schemaVersion !== 1 || payload.target !== target || payload.nodePtyVersion !== NODE_PTY_VERSION ||
      !Array.isArray(payload.files) || payload.files.length > 128) {
    throw new Error(`Missing or incompatible native terminal runtime for ${target}; reinstall this Weft release.`);
  }
  const seen = new Set();
  const files = payload.files.map((file) => {
    if (!file || typeof file.path !== "string" || !validRuntimePath(file.path, target) || seen.has(file.path.toLowerCase()) ||
        ![0o644, 0o755].includes(file.mode) || typeof file.data !== "string" ||
        /[^A-Za-z0-9+/=]/.test(file.data)) {
      throw new Error("Unsafe native terminal runtime file entry.");
    }
    seen.add(file.path.toLowerCase());
    const data = Buffer.from(file.data, "base64");
    if (data.toString("base64") !== file.data) throw new Error("Invalid native terminal runtime encoding.");
    if (sha256(data) !== file.sha256) throw new Error(`Native terminal runtime integrity check failed: ${file.path}`);
    return { path: file.path, mode: file.path.endsWith("/spawn-helper") ? 0o755 : 0o644, data };
  });
  for (const path of ["package.json", "LICENSE", "LICENSE-winpty", ...NATIVE_JS_FILES,
    ...requiredNativeFiles(target).map((name) => `prebuilds/${target}/${name}`)]) {
    if (!seen.has(path.toLowerCase())) throw new Error(`Missing native terminal runtime file: ${path}`);
  }
  const metadata = JSON.parse(files.find((file) => file.path === "package.json").data.toString("utf8"));
  if (metadata.name !== "node-pty" || metadata.version !== NODE_PTY_VERSION || metadata.main !== "./lib/index.js" ||
      metadata.type === "module" || metadata.scripts || metadata.exports) {
    throw new Error("Incompatible native terminal package metadata.");
  }
  return files;
}

export async function fetchNativeRuntime(url, metadata) {
  if (!metadata || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > MAX_RUNTIME_BYTES ||
      !/^[a-f0-9]{64}$/i.test(metadata.sha256 ?? "")) {
    throw new Error("Release manifest has no valid native terminal runtime size/checksum.");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Native terminal runtime download failed (HTTP ${response.status}).`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > metadata.bytes) throw new Error("Native terminal runtime download exceeds manifest size.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== metadata.bytes || sha256(bytes) !== metadata.sha256.toLowerCase()) {
    throw new Error("Native terminal runtime integrity check failed.");
  }
  return bytes;
}

export async function stageNativeRuntime({ fromDir, manifest, base, stageDir, target = `${process.platform}-${process.arch}` }) {
  if (!NATIVE_TARGETS.includes(target)) return false;
  const name = nativeAssetName(target);
  let bytes;
  if (fromDir) {
    const source = join(fromDir, name);
    if (!existsSync(source)) throw new Error(`Missing native terminal runtime payload ${name}; rebuild Weft before installing.`);
    if (statSync(source).size > MAX_RUNTIME_BYTES) throw new Error("Native terminal runtime exceeds the size limit.");
    bytes = readFileSync(source);
  } else {
    if (manifest?.nativeRuntime?.schemaVersion !== 1 || manifest.nativeRuntime.nodePtyVersion !== NODE_PTY_VERSION ||
        manifest.nativeRuntime.targets?.[target] !== name) {
      throw new Error(`Release is missing a compatible native terminal runtime for ${target}; use a complete Weft release.`);
    }
    bytes = await fetchNativeRuntime(`${base}/${name}`, manifest.files?.[name]);
  }
  const files = decodeNativeRuntime(bytes, target);
  for (const file of files) {
    const parts = file.path.split("/");
    mkdirSync(join(stageDir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(stageDir, ...parts), file.data, { mode: file.mode, flag: "wx" });
  }
  return true;
}
