// SPDX-License-Identifier: Apache-2.0
//
// Persisted pairing identity: ~/.weft/pairing-identity.json.
//
// By default, `weft start` reuses the SAME channelId + keypair across runs so an already-paired
// phone reconnects without rescanning. A user can explicitly trade that convenience for per-run
// forward secrecy with `weft set-pairing ephemeral`, or rotate the persistent identity on demand
// with `weft rotate-pairing`. The in-session `/weft` extension remains per-session and does not
// use this identity.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportKeyPair, generateKeyPair, importKeyPair, randomChannelId } from "@aasis21/weft-shared";
import { weftHome } from "./projects.mjs";

const STORE_FILE = "pairing-identity.json";

function storePath(baseDir) {
  return join(weftHome(baseDir), STORE_FILE);
}

function ensureDir(baseDir) {
  const dir = weftHome(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on Windows.
  }
  return dir;
}

function writeIdentityFile(record, { baseDir } = {}) {
  const dir = ensureDir(baseDir);
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
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

/** Inspect saved trust without importing or creating private key material. */
export function readSavedPairing({ baseDir } = {}) {
  try {
    const record = JSON.parse(readFileSync(storePath(baseDir), "utf8"));
    if (!record || typeof record.channelId !== "string" || !record.channelId.trim() || !record.privateKeyJwk ||
        typeof record.privateKeyJwk !== "object" || Array.isArray(record.privateKeyJwk) ||
        record.peerPublicKeyB64 != null && typeof record.peerPublicKeyB64 !== "string") {
      return { paired: null, state: "unavailable" };
    }
    return { paired: typeof record.peerPublicKeyB64 === "string" && !!record.peerPublicKeyB64,
      state: "available" };
  } catch (error) {
    return error.code === "ENOENT" ? { paired: false, state: "available" }
      : { paired: null, state: "unavailable" };
  }
}

/** Read the persisted identity and import its key for pairing.
 * The stored peer key supports automatic reconnection before a fresh phone hello arrives. */
export async function loadPersistedIdentity({ baseDir } = {}) {
  try {
    const raw = readFileSync(storePath(baseDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.channelId || !parsed.privateKeyJwk) return null;
    const keyPair = await importKeyPair({ privateKeyJwk: parsed.privateKeyJwk });
    return {
      channelId: parsed.channelId,
      keyPair,
      everConnected: parsed.everConnected === true,
      peerPublicKeyB64: typeof parsed.peerPublicKeyB64 === "string" ? parsed.peerPublicKeyB64 : null,
    };
  } catch {
    return null;
  }
}

/** Load the persisted identity, minting and saving one on first use. Every subsequent call (any
 * process, any run) returns the exact same channelId + keypair until cleared/rotated. */
export async function getOrCreatePersistedIdentity({ baseDir } = {}) {
  const existing = await loadPersistedIdentity({ baseDir });
  if (existing) return existing;
  const keyPair = await generateKeyPair();
  const { publicKeyB64, privateKeyJwk } = await exportKeyPair(keyPair);
  const channelId = randomChannelId();
  writeIdentityFile({ channelId, publicKeyB64, privateKeyJwk, everConnected: false }, { baseDir });
  return { channelId, keyPair, everConnected: false, peerPublicKeyB64: null };
}

/** Force a new persisted channelId + keypair (`weft rotate-pairing`) — e.g. if a device/QR may
 * have leaked. Any phone paired against the old identity will need to rescan, so this always
 * resets everConnected (and the remembered peer key) back to unset. */
export async function rotatePersistedIdentity({ baseDir } = {}) {
  const keyPair = await generateKeyPair();
  const { publicKeyB64, privateKeyJwk } = await exportKeyPair(keyPair);
  const channelId = randomChannelId();
  writeIdentityFile({ channelId, publicKeyB64, privateKeyJwk, everConnected: false }, { baseDir });
  return { channelId, keyPair, everConnected: false, peerPublicKeyB64: null };
}

/** Mark the CURRENT persisted identity as having had a phone connect at least once, and remember
 * ITS public key too (called from the listener's bindPeer once a phone genuinely binds). No-op if
 * pairing isn't persistent (no file to mark) or the channelId has since rotated out from under the
 * caller. Always refreshes peerPublicKeyB64 (not just on the first connect) so a later re-pair with
 * a different phone keypair on the SAME channel updates who we'll optimistically bind to next run. */
export function markPersistedIdentityConnected(channelId, peerPublicKeyB64, { baseDir } = {}) {
  try {
    const file = storePath(baseDir);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.channelId !== channelId) return;
    if (parsed.everConnected === true && parsed.peerPublicKeyB64 === peerPublicKeyB64) return;
    writeIdentityFile({ ...parsed, everConnected: true, peerPublicKeyB64 }, { baseDir });
  } catch {
    // Not persisted (ephemeral mode) or unreadable — nothing to mark.
  }
}

/** Remove the persisted identity file entirely (e.g. when switching back to ephemeral mode). */
export function clearPersistedIdentity({ baseDir } = {}) {
  try {
    unlinkSync(storePath(baseDir));
  } catch {
    // Already absent — nothing to clear.
  }
}
