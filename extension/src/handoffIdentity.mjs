// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importKeyPair } from "@aasis21/weft-shared";

export function writeIdentityFile({ channelId, publicKeyB64, privateKeyJwk }) {
  if (!channelId || !publicKeyB64 || !privateKeyJwk) {
    throw new Error("Weft spawn: channelId, publicKeyB64, and privateKeyJwk are required");
  }
  const file = join(tmpdir(), `weft-identity-${process.pid}-${randomUUID()}.json`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ channelId, publicKeyB64, privateKeyJwk }), "utf8");
  } finally {
    closeSync(fd);
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
  return { channelId: parsed.channelId, laptopKeys };
}
