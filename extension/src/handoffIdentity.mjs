// SPDX-License-Identifier: Apache-2.0
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKeyPair } from "@aasis21/weft-shared";

/**
 * Write the private identity a launched session reads through WEFT_IDENTITY_FILE. Station passes
 * `file` (requests/<id>/identity.json); without one a throwaway temp file is used.
 */
export function writeIdentityFile(
  {
    channelId,
    publicKeyB64,
    privateKeyJwk,
    pairingToken = null,
    pairingExpiresAt = null,
    requestId = null,
    operationOwnerToken = null,
  },
  { file: suppliedFile = null } = {},
) {
  if (!channelId || !publicKeyB64 || !privateKeyJwk) {
    throw new Error("Weft spawn: channelId, publicKeyB64, and privateKeyJwk are required");
  }
  const file = suppliedFile ?? join(tmpdir(), `weft-identity-${process.pid}-${randomUUID()}.json`);
  if (existsSync(file)) {
    const error = new Error(`Weft spawn: identity file already exists for request ${requestId}`);
    error.code = "EEXIST";
    throw error;
  }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        channelId,
        publicKeyB64,
        privateKeyJwk,
        ...(pairingToken ? { pairingToken } : {}),
        ...(pairingExpiresAt ? { pairingExpiresAt } : {}),
        ...(requestId ? { requestId } : {}),
        ...(operationOwnerToken ? { operationOwnerToken } : {}),
      }),
      "utf8",
    );
    closeSync(fd);
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort on Windows.
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // It may already have been closed after a successful write.
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort.
    }
    throw err;
  }
  return file;
}

export async function readIdentityFile(file) {
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed?.channelId || !parsed.privateKeyJwk) {
    throw new Error("identity file is missing channelId or privateKeyJwk");
  }
  const laptopKeys = await importKeyPair({ privateKeyJwk: parsed.privateKeyJwk });
  return {
    channelId: parsed.channelId,
    laptopKeys,
    pairingToken: typeof parsed.pairingToken === "string" ? parsed.pairingToken : null,
    pairingExpiresAt: Number.isSafeInteger(parsed.pairingExpiresAt) ? parsed.pairingExpiresAt : null,
    trustedPeerPublicKeyB64:
      typeof parsed.trustedPeerPublicKeyB64 === "string" ? parsed.trustedPeerPublicKeyB64 : null,
    controllerDeviceId:
      typeof parsed.controllerDeviceId === "string" ? parsed.controllerDeviceId : null,
    controllerName:
      typeof parsed.controllerName === "string" ? parsed.controllerName : null,
    requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
    operationOwnerToken: typeof parsed.operationOwnerToken === "string" ? parsed.operationOwnerToken : null,
  };
}

export function persistHandoffController(
  file,
  {
    trustedPeerPublicKeyB64,
    controllerDeviceId = null,
    controllerName = null,
    requestId = null,
    operationOwnerToken = null,
  },
) {
  if (!file || !trustedPeerPublicKeyB64) {
    throw new Error("Weft handoff recovery requires an identity file and trusted phone key");
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (
    (requestId && parsed.requestId !== requestId) ||
    (operationOwnerToken && parsed.operationOwnerToken !== operationOwnerToken)
  ) {
    throw new Error("Weft handoff recovery identity ownership changed");
  }
  const next = {
    ...parsed,
    trustedPeerPublicKeyB64,
    ...(controllerDeviceId ? { controllerDeviceId } : {}),
    ...(controllerName ? { controllerName } : {}),
  };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(next), "utf8");
    closeSync(fd);
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort on Windows.
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // It may already have been closed after a successful write.
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of the temporary file.
    }
    throw error;
  }
}

export function cleanupIdentityAfterPairing(file, { durable = false, force = false } = {}) {
  if (!file || (durable && !force)) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
