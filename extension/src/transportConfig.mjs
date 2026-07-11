// SPDX-License-Identifier: Apache-2.0
// Single source of truth for the user's transport choice: ~/.weft/weft.config.json. Mirrors
// projects.mjs's storage pattern (same ~/.weft home, same atomic-write-then-rename) so both the
// Copilot CLI extension (extension.mjs) and the device-station CLI (weft.mjs) pick up whatever
// transport the user configured via `weft set-transport`. There is NO env var override for this
// (no WEFT_TRANSPORT, no .env) — a reinstall/rebuild only ever touches installed code under
// ~/.copilot/extensions/weft, never this file, so it can never silently clobber the user's
// choice. The config file is always read fresh; nothing here falls back to process.env.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { weftHome } from "./projects.mjs";

const STORE_FILE = "weft.config.json";

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
 * "webpubsub" are intentionally no longer offered by any user-facing command (weft
 * set-transport, /weft <name>) — see transportFactory.mjs's SUPPORTED_TRANSPORT_NAMES — but are
 * still accepted here so existing persisted configs / tests keep working. "devtunnel" persists as
 * a bare marker (no url yet): the actual shared-relay base URL is looked up from the running
 * relay's registry file at resolve time by resolveTransport() (see transportFactory.mjs), never
 * stored. */
function isValidTransportDescriptor(t) {
  if (!t || typeof t !== "object") return false;
  if (t.kind === "local") return true;
  if (t.kind === "devtunnel") return true;
  if (t.kind === "supabase") return typeof t.url === "string" && typeof t.anonKey === "string";
  if (t.kind === "webpubsub") return typeof t.negotiateUrl === "string";
  return false;
}

/** Read the whole config object (weft.config.json), or {} if unset/unreadable/invalid. Kept
 * generic — beyond `transport`, other user-facing settings can be added here over time — so this
 * one file stays the single place a user's ~/.weft config lives. */
function loadConfig({ baseDir } = {}) {
  const file = storePath(baseDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomically overwrite weft.config.json with `config`. */
function writeConfig(config, { baseDir } = {}) {
  const dir = ensureDir(baseDir);
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.weft.config.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
}

/** Read the persisted transport descriptor, or null if unset/unreadable/invalid. */
export function loadTransportConfig({ baseDir } = {}) {
  const { transport } = loadConfig({ baseDir });
  return isValidTransportDescriptor(transport) ? transport : null;
}

/** Persist a transport descriptor as the user's chosen default (`weft set-transport`). Merges
 * into weft.config.json rather than overwriting it, so other config keys survive. */
export function saveTransportConfig(descriptor, { baseDir } = {}) {
  if (!isValidTransportDescriptor(descriptor)) {
    throw new Error(
      'Weft: invalid transport descriptor (kind must be "supabase" or "devtunnel" — or, for ' +
        'internal/testing use, "local"/"webpubsub" — with the fields that kind requires)',
    );
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, transport: descriptor }, { baseDir });
  return descriptor;
}

/** Remove the persisted transport choice (other config keys are left untouched). There is no env
 * var / built-in default to fall back to for supabase credentials — after clearing, resolving a
 * transport requires running `weft set-transport` again. */
export function clearTransportConfig({ baseDir } = {}) {
  const config = loadConfig({ baseDir });
  if (!("transport" in config)) return;
  delete config.transport;
  if (Object.keys(config).length === 0) {
    try {
      unlinkSync(storePath(baseDir));
    } catch {
      // Already absent, or unreadable — either way there's nothing to clear.
    }
    return;
  }
  writeConfig(config, { baseDir });
}

/** True if the user opted into persistent pairing (`weft set-pairing persistent`) — i.e. `weft
 * start` and the `/weft` extension should reuse the same channelId + keypair from
 * pairingIdentity.mjs across every run instead of minting a fresh one. Defaults to false (the
 * original forward-secret-by-default behavior) until explicitly enabled. */
export function isPersistentPairingEnabled({ baseDir } = {}) {
  return loadConfig({ baseDir })?.pairing?.persistent === true;
}

/** Persist the pairing mode (`persistent` or `ephemeral`) as this device's default going forward.
 * Merges into weft.config.json rather than overwriting it, same as saveTransportConfig. */
export function savePairingMode(mode, { baseDir } = {}) {
  if (mode !== "persistent" && mode !== "ephemeral") {
    throw new Error('Weft: pairing mode must be "persistent" or "ephemeral"');
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, pairing: { persistent: mode === "persistent" } }, { baseDir });
  return mode;
}

const MAX_DEVICE_NAME_LENGTH = 60;

/** Read the user-chosen display name for this device (`weft set-name`), or null if unset —
 * callers (listener.mjs, weft.mjs's `weft start` header) fall back to os.hostname() themselves so
 * this module has no opinion about the default. Set during install (install.ps1/install.sh
 * prompt, defaulting to the machine hostname) or any time after via `weft set-name`. */
export function loadDeviceName({ baseDir } = {}) {
  const { deviceName } = loadConfig({ baseDir });
  return typeof deviceName === "string" && deviceName.trim() ? deviceName.trim() : null;
}

/** Persist this device's display name (shown to phones as the DEVICES entry / senderName on
 * every message this listener sends). Merges into weft.config.json, same as saveTransportConfig. */
export function saveDeviceName(name, { baseDir } = {}) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("Weft: device name must be a non-empty string");
  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    throw new Error(`Weft: device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer`);
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, deviceName: trimmed }, { baseDir });
  return trimmed;
}
