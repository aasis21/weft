// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const TERMINAL_ID = Symbol.for("weft.runtime-terminal-identity.v1");
const GENERATIONS = Symbol.for("weft.runtime-generations.v1");

function required(value, name) {
  const clean = String(value ?? "").trim();
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}

function canonicalPath(path, platform) {
  const absolute = resolve(required(path, "storePath"));
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // The store can be identified before its database file is created.
  }
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function deriveStoreAuthority(storePath, { platform = process.platform } = {}) {
  const canonical = canonicalPath(storePath, platform);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function getTerminalInstanceId({ scope = globalThis, randomId = randomUUID } = {}) {
  if (!scope[TERMINAL_ID]) scope[TERMINAL_ID] = randomId();
  return scope[TERMINAL_ID];
}

export function nextRuntimeGeneration(
  { storeAuthority, sessionId, terminalInstanceId },
  { scope = globalThis } = {},
) {
  const key = [
    required(storeAuthority, "storeAuthority"),
    required(sessionId, "sessionId"),
    required(terminalInstanceId, "terminalInstanceId"),
  ].join("\0");
  if (!scope[GENERATIONS]) scope[GENERATIONS] = new Map();
  const generation = (scope[GENERATIONS].get(key) ?? 0) + 1;
  scope[GENERATIONS].set(key, generation);
  return generation;
}

export function createRuntimeIdentity(
  {
    storePath,
    storeAuthority = storePath ? deriveStoreAuthority(storePath) : null,
    sessionId,
    terminalInstanceId,
    runtimeInstanceId,
    generation,
  },
  { scope = globalThis, randomId = randomUUID } = {},
) {
  const terminalId = terminalInstanceId ?? getTerminalInstanceId({ scope, randomId });
  const identity = {
    storeAuthority: required(storeAuthority, "storeAuthority"),
    sessionId: required(sessionId, "sessionId"),
    terminalInstanceId: required(terminalId, "terminalInstanceId"),
    runtimeInstanceId: required(runtimeInstanceId ?? randomId(), "runtimeInstanceId"),
  };
  identity.generation = generation ?? nextRuntimeGeneration(identity, { scope });
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new Error("generation must be a positive safe integer");
  }
  return Object.freeze(identity);
}
