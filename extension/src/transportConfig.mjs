// SPDX-License-Identifier: Apache-2.0
// Single source of truth for the user's transport CHOICE: ~/.weft/weft.config.json is a small
// pointer file that only records which transport kind the user picked. The transport's own
// connection details live in a sibling file named after the transport itself:
//   - kind: "supabase"  → ~/.weft/supabase.json  ({url, anonKey})
//   - kind: "devtunnel" → ~/.weft/devtunnel.json (runtime registry written by the relay child,
//                                                  see devtunnel.mjs — not user config)
// Mirrors projects.mjs's storage pattern (same ~/.weft home, same atomic-write-then-rename) so
// both the Copilot CLI extension (extension.mjs) and the device-station CLI (weft.mjs) pick up
// whatever transport the user configured via `weft set-transport`. There is NO env var override
// for any of this (no WEFT_TRANSPORT, no .env) — a reinstall/rebuild only ever touches installed
// code under ~/.copilot/extensions/weft, never these files, so it can never silently clobber the
// user's choice or credentials. The config file is always read fresh; nothing here falls back to
// process.env.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { weftHome } from "./projects.mjs";

const STORE_FILE = "weft.config.json";
const SUPABASE_CREDS_FILE = "supabase.json";

function storePath(baseDir) {
  return join(weftHome(baseDir), STORE_FILE);
}

function supabaseCredsPath(baseDir) {
  return join(weftHome(baseDir), SUPABASE_CREDS_FILE);
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

/** Same shape validation as shared/pairing.mjs's isValidTransportDescriptor. "local" is accepted
 * here for the harness/tests but not offered by any user-facing command (see
 * transportFactory.mjs's SUPPORTED_TRANSPORT_NAMES). Both "supabase" and "devtunnel" persist as
 * bare markers (no connection details inline): supabase's url/anonKey live in the sibling
 * supabase.json (see saveSupabaseCredentials below); devtunnel's live relay URL is looked up
 * from the running relay's devtunnel.json at resolve time by resolveTransport() (see
 * transportFactory.mjs), never stored. */
function isValidTransportDescriptor(t) {
  if (!t || typeof t !== "object") return false;
  if (t.kind === "local") return true;
  if (t.kind === "devtunnel") return true;
  if (t.kind === "supabase") return true;
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
 * into weft.config.json rather than overwriting it, so other config keys survive. For
 * "supabase", the descriptor is a bare `{kind: "supabase"}` marker — url/anonKey are stored
 * separately via saveSupabaseCredentials so the pointer and the creds have independent
 * lifecycles (installer seeds the creds once; `set-transport supabase` flips the pointer
 * without touching them; overrides pass fresh --url/--anon-key to overwrite the creds file). */
export function saveTransportConfig(descriptor, { baseDir } = {}) {
  if (!isValidTransportDescriptor(descriptor)) {
    throw new Error(
      'Weft: invalid transport descriptor (kind must be "supabase" or "devtunnel" — or, for ' +
        'harness/testing use, "local")',
    );
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, transport: { kind: descriptor.kind } }, { baseDir });
  return { kind: descriptor.kind };
}

/** Persist the Supabase URL + anon key to ~/.weft/supabase.json (atomic, 0600). This is the
 * ONLY place these credentials are written; the pointer file (weft.config.json) never carries
 * them. Both fields are required together — a partial write would leave the file in an
 * unresolvable half-state at pairing time. */
export function saveSupabaseCredentials({ url, anonKey }, { baseDir } = {}) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("Weft: supabase url must be a non-empty string");
  }
  if (typeof anonKey !== "string" || !anonKey.trim()) {
    throw new Error("Weft: supabase anonKey must be a non-empty string");
  }
  const dir = ensureDir(baseDir);
  const file = join(dir, SUPABASE_CREDS_FILE);
  const tmp = join(dir, `.supabase.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }, null, 2)}\n`, { mode: 0o600 });
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
  return { url: url.trim(), anonKey: anonKey.trim() };
}

/** Read the persisted Supabase credentials, or null if the file is missing/unreadable/invalid.
 * Callers that need to resolve a live transport should treat null as "credentials not
 * installed" and throw an actionable, path-mentioning error — see transportFactory.mjs. */
export function loadSupabaseCredentials({ baseDir } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(supabaseCredsPath(baseDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.url !== "string" || typeof parsed.anonKey !== "string") return null;
    return { url: parsed.url, anonKey: parsed.anonKey };
  } catch {
    return null;
  }
}

/** Absolute path of the Supabase credentials file, for building actionable error messages. */
export function supabaseCredentialsPath({ baseDir } = {}) {
  return supabaseCredsPath(baseDir);
}

/** Delete ~/.weft/supabase.json outright. Not called on `set-transport clear` (clearing the
 * pointer intentionally leaves stored creds in place so switching back is a one-liner); provided
 * for tests and future explicit "forget credentials" commands. */
export function clearSupabaseCredentials({ baseDir } = {}) {
  try {
    unlinkSync(supabaseCredsPath(baseDir));
  } catch {
    // Already absent — nothing to do.
  }
}

/** Remove the persisted transport CHOICE (other config keys are left untouched, and stored
 * Supabase credentials at ~/.weft/supabase.json are left in place — clearing the pointer is
 * deliberately a lightweight action, not a "forget everything" nuke). After clearing, resolving
 * a transport requires running `weft set-transport` again to pick a kind. */
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
