// SPDX-License-Identifier: Apache-2.0
// Persisted `weft-cli set-transport` choice, read by resolveTransportDescriptor() in
// transportFactory.mjs. Mirrors projects.mjs's storage pattern (same ~/.weft home, same
// atomic-write-then-rename) so both the Copilot CLI extension (extension.mjs) and the
// device-station CLI (weft-cli.mjs) pick up whatever transport the user configured, without
// needing an explicit WEFT_TRANSPORT env var / .env file (which remains a supported override).
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { weftHome } from "./projects.mjs";

const STORE_FILE = "transport.json";

function storePath(baseDir) {
  return join(weftHome(baseDir), STORE_FILE);
}

function ensureDir(baseDir) {
  const dir = weftHome(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is best-effort on Windows.
  }
  return dir;
}

/** Same shape validation as shared/pairing.mjs's isValidTransportDescriptor. "local" and
 * "webpubsub" are intentionally no longer offered by any user-facing command (weft-cli
 * set-transport, /weft <name>) — see transportFactory.mjs's SUPPORTED_TRANSPORT_NAMES — but are
 * still accepted here so existing persisted configs / tests keep working. "devtunnel" persists as
 * a bare marker (no url yet): the actual shared-relay URL is provisioned fresh per channelId at
 * resolve time by resolveTransportForChannel(), never stored. */
function isValidTransportDescriptor(t) {
  if (!t || typeof t !== "object") return false;
  if (t.kind === "local") return true;
  if (t.kind === "devtunnel") return true;
  if (t.kind === "supabase") return typeof t.url === "string" && typeof t.anonKey === "string";
  if (t.kind === "webpubsub") return typeof t.negotiateUrl === "string";
  return false;
}

/** Read the persisted transport descriptor, or null if unset/unreadable/invalid. */
export function loadTransportConfig({ baseDir } = {}) {
  const file = storePath(baseDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isValidTransportDescriptor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a transport descriptor as the user's chosen default (`weft-cli set-transport`). */
export function saveTransportConfig(descriptor, { baseDir } = {}) {
  if (!isValidTransportDescriptor(descriptor)) {
    throw new Error(
      'Weft: invalid transport descriptor (kind must be "supabase" or "devtunnel" — or, for ' +
        'internal/testing use, "local"/"webpubsub" — with the fields that kind requires)',
    );
  }
  const dir = ensureDir(baseDir);
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.transport.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on Windows.
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on Windows.
  }
  return descriptor;
}

/** Remove the persisted choice, reverting to env vars / the built-in default. */
export function clearTransportConfig({ baseDir } = {}) {
  try {
    unlinkSync(storePath(baseDir));
  } catch {
    // Already absent, or unreadable — either way there's nothing to clear.
  }
}
