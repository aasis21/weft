// SPDX-License-Identifier: Apache-2.0
//
// A STABLE, NON-SECRET device id for the `weft-cli` listener, persisted at ~/.weft/device-id.
//
// Deliberately separate from pairing crypto: `weft-cli start` still mints a FRESH keypair +
// channelId every run (see listener.mjs) so the encrypted session key never survives a restart —
// that's what keeps every relayed conversation forward-secret. This id carries no cryptographic
// weight at all; it is just an opaque random tag so the phone can recognize "this is the same
// laptop I paired with before" across restarts and dedupe its device list instead of accumulating
// a new stale entry every time the listener's ephemeral channelId rotates. Safe to read, log, or
// leak — it derives no secret and cannot be used to decrypt or impersonate anything.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";

const DEVICE_ID_FILE = "device-id";

export function getOrCreateDeviceId({ baseDir } = {}) {
  const dir = weftHome(baseDir);
  const file = join(dir, DEVICE_ID_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // No id yet (or unreadable) — mint a fresh one below.
  }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${DEVICE_ID_FILE}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, `${id}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort on Windows.
    }
    renameSync(tmp, file);
  } catch {
    // Best-effort persistence: if the write fails, the caller still gets a usable id for THIS
    // run — it just won't survive a restart until the directory becomes writable.
  }
  return id;
}
