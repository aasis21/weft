// SPDX-License-Identifier: Apache-2.0
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKeyPair } from "@aasis21/weft-shared";
import { launchIdentityPath } from "./launchOperations.mjs";

export function writeIdentityFile(
  { channelId, publicKeyB64, privateKeyJwk, operationId = null, operationOwnerToken = null },
  { baseDir } = {},
) {
  if (!channelId || !publicKeyB64 || !privateKeyJwk) {
    throw new Error("Weft spawn: channelId, publicKeyB64, and privateKeyJwk are required");
  }
  const file = operationId
    ? launchIdentityPath(operationId, { baseDir })
    : join(tmpdir(), `weft-identity-${process.pid}-${randomUUID()}.json`);
  if (existsSync(file)) {
    const error = new Error(`Weft spawn: identity file already exists for operation ${operationId}`);
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
        ...(operationId ? { operationId } : {}),
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
    operationId: typeof parsed.operationId === "string" ? parsed.operationId : null,
    operationOwnerToken: typeof parsed.operationOwnerToken === "string" ? parsed.operationOwnerToken : null,
  };
}
