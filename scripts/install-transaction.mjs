// SPDX-License-Identifier: Apache-2.0
import { existsSync, renameSync, rmSync } from "node:fs";

export function renameWithRetry(source, destination, {
  rename = renameSync, platform = process.platform,
  wait = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(source, destination); }
    catch (error) {
      // Windows scanners can briefly hold just-extracted native files. Persistent
      // sharing/permission failures still reach the normal rollback path.
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 7) throw error;
      wait(Math.min(80 * (2 ** attempt), 500));
    }
  }
}

export function commitStagedFiles(files, { rename = renameWithRetry, remove = rmSync, warn = console.warn } = {}) {
  const changes = [];
  try {
    for (const file of files) {
      const change = { file, backedUp: false, installed: false };
      changes.push(change);
      if (existsSync(file.dest)) {
        rename(file.dest, file.backup);
        change.backedUp = true;
      }
      rename(file.stage, file.dest);
      change.installed = true;
    }
  } catch (error) {
    const failures = [];
    for (const change of changes.reverse()) {
      try {
        if (change.installed) remove(change.file.dest, { force: true, recursive: Boolean(change.file.recursive) });
        if (change.backedUp) rename(change.file.backup, change.file.dest);
      } catch (rollbackError) {
        failures.push(new Error(`Could not restore ${change.file.dest}; recovery copy retained at ${change.file.backup}.`, { cause: rollbackError }));
      }
    }
    if (failures.length) throw new AggregateError([error, ...failures], failures.map((failure) => failure.message).join("\n"));
    throw error;
  }
  // The commit is complete. Never roll back after deleting any recovery copy.
  // Windows can retain loaded DLLs until the old Station process is restarted.
  for (const { file, backedUp } of changes) {
    if (!backedUp) continue;
    try {
      remove(file.backup, { force: true, recursive: Boolean(file.recursive) });
    } catch (error) {
      warn(`Installed ${file.name}, but its old recovery copy could not be removed (${error.code ?? error.message}): ${file.backup}. Restart Station before removing it.`);
    }
  }
}
