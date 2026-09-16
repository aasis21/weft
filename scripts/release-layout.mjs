// SPDX-License-Identifier: Apache-2.0

export const RELEASE_BUNDLES = [
  { name: "extension.mjs", entryPoint: "src/extension.mjs" },
  { name: "activeRuntime.mjs", entryPoint: "src/activeRuntime.mjs" },
  { name: "relayServerProcess.mjs", entryPoint: "src/relayServerProcess.mjs" },
  { name: "devtunnelHostWatchdog.mjs", entryPoint: "src/devtunnelHostWatchdog.mjs" },
  { name: "weft.mjs", entryPoint: "bin/weft.mjs" },
];

export const RELEASE_BUNDLE_NAMES = RELEASE_BUNDLES.map(({ name }) => name);
export const RELEASE_SKILL_NAME = "weft-skill.md";

export function releaseInstallDescriptor() {
  return {
    schemaVersion: 1,
    bundles: [...RELEASE_BUNDLE_NAMES],
    skill: RELEASE_SKILL_NAME,
  };
}

export function validateInstallDescriptor(install) {
  if (install?.schemaVersion !== 1 || !Array.isArray(install.bundles) ||
      typeof install.skill !== "string") {
    throw new Error("Release manifest is missing compatible install metadata.");
  }
  const names = [...install.bundles, install.skill];
  if (install.bundles.length === 0 || !install.bundles.includes("extension.mjs") ||
      !install.bundles.includes("weft.mjs") || new Set(names).size !== names.length ||
      names.some((name) => typeof name !== "string" || name.length > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))) {
    throw new Error("Release manifest contains an invalid install file set.");
  }
  return {
    bundles: [...install.bundles],
    skill: install.skill,
  };
}
