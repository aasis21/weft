// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_RELEASE_FILES } from "./generate-release-manifest.mjs";
import { decodeNativeRuntime, NATIVE_TARGETS, nativeAssetName, nativeRuntimeDescriptor, sha256 } from "./native-runtime.mjs";

export function verifyReleaseManifest(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.nativeRuntime?.nodePtyVersion !== nativeRuntimeDescriptor().nodePtyVersion ||
      manifest.nativeRuntime.schemaVersion !== 1) {
    throw new Error("Release manifest is missing compatible native terminal runtime metadata; rebuild before shipping.");
  }
  for (const name of REQUIRED_RELEASE_FILES) {
    const bytes = readFileSync(join(directory, name));
    if (manifest.files?.[name]?.bytes !== bytes.length || manifest.files[name].sha256 !== sha256(bytes)) {
      throw new Error(`Release integrity check failed: ${name}`);
    }
    const target = NATIVE_TARGETS.find((item) => nativeAssetName(item) === name);
    if (target) {
      if (manifest.nativeRuntime.targets?.[target] !== name) throw new Error(`Missing native runtime target: ${target}`);
      decodeNativeRuntime(bytes, target);
    }
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = verifyReleaseManifest(resolve(process.argv[2] ?? "mobile/dist"));
  console.log(`Verified release ${manifest.version}, including all native terminal runtimes.`);
}
