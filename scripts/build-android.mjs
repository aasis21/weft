// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const android = fileURLToPath(new URL("../mobile/android/", import.meta.url));
const windows = process.platform === "win32";
const variant = process.argv[2] ?? "debug";
if (process.argv.length > 3 || !["debug", "release"].includes(variant)) {
  throw new Error("Usage: node scripts/build-android.mjs [debug|release]");
}
const task = variant === "release" ? ":app:assembleRelease" : ":app:assembleDebug";
const result = spawnSync(
  windows ? "cmd.exe" : "sh",
  [...(windows ? ["/d", "/c", ".\\gradlew.bat"] : ["./gradlew"]), "--no-daemon", task],
  { cwd: android, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const apk = join(android, "app", "build", "outputs", "apk", variant,
  variant === "release" ? "app-release-unsigned.apk" : "app-debug.apk");
if (!existsSync(apk)) throw new Error(`Gradle did not produce the expected APK: ${apk}`);
console.log(`APK: ${apk}`);
