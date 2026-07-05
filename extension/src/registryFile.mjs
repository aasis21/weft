// SPDX-License-Identifier: Apache-2.0
//
// Generic helper for small JSON "is this shared resource still alive" registry files under
// ~/.helm (see projects.mjs's helmHome()). Used by devtunnel.mjs (shared relay/tunnel discovery)
// and listener.mjs (live device-connection bookkeeping) — this file knows nothing about either;
// it just reads/writes JSON atomically and answers "is this pid still running", cross-platform.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { helmHome } from "./projects.mjs";

/** Read and JSON-parse a registry file under ~/.helm. Returns null if missing/corrupt. */
export function readRegistry(fileName, { baseDir } = {}) {
  const file = join(helmHome(baseDir), fileName);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically write a registry file under ~/.helm (tmp file + rename, same pattern as
 * deviceIdentity.mjs) so a reader never observes a half-written file. Best-effort: a failed write
 * only means the resource isn't discoverable by OTHER processes, not that the caller's own
 * in-memory state is invalid.
 */
export function writeRegistryAtomic(fileName, data, { baseDir } = {}) {
  const dir = helmHome(baseDir);
  const file = join(dir, fileName);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort on Windows.
    }
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort delete of a registry file under ~/.helm. Never throws. */
export function clearRegistry(fileName, { baseDir } = {}) {
  const file = join(helmHome(baseDir), fileName);
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Cross-platform "is this pid still running" check. Signal 0 sends nothing — on POSIX and
 * Windows alike it only probes existence/permission, never actually terminates or interrupts
 * the target process.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it — still "alive" for our
    // purposes (we only care about existence, not signalability).
    return err?.code === "EPERM";
  }
}
