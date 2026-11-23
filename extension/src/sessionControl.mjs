// SPDX-License-Identifier: Apache-2.0
//
// Local control pipe between Station (client) and each Copilot session (server), plus the
// generic authenticated pipe both Weft background workers use.
//
// Wire format (unchanged from the 0.2.7x lifecycle endpoint, so a new CLI can still quiesce an old
// background worker): one JSON line per connection, `{ version: 1, id, command, auth, payload }`,
// answered by one JSON line `{ version: 1, id, ok, result | error }`. The capability travels in
// that first (and only) frame and is compared in constant time.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";
import { readSessionCapability } from "./sessionRegistry.mjs";

export const CONTROL_FRAME_VERSION = 1;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1_024;
/** Station's deadline for one session command (LLD §5.2). A timeout is NOT a cancellation. */
export const SESSION_COMMAND_TIMEOUT_MS = 5_000;
export const SESSION_CONTROL_COMMANDS = Object.freeze([
  "probe",
  "activate",
  "resetLink",
  "replaceController",
  "quiesce",
  "traffic",
  "reloadExtension",
]);

function privateMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on Windows.
  }
}

function endpointStem(id) {
  const value = String(id ?? "").trim();
  if (!value) throw new Error("control endpoint id is required");
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Pipe/socket address for a control endpoint. Background workers keep the historical
 * `weft-runtime` prefix so an updated CLI can still reach (and quiesce) an older worker.
 */
export function controlEndpointAddress(id, { baseDir, platform = process.platform, prefix = "weft-runtime" } = {}) {
  const stem = endpointStem(id);
  if (platform === "win32") return `\\\\.\\pipe\\${prefix}-${stem}`;
  const dir = join(weftHome(baseDir), "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateMode(dir, 0o700);
  return join(dir, prefix === "weft-runtime" ? `${stem}.sock` : `${prefix}-${stem}.sock`);
}

/** Pipe address of one session's control server. */
export function sessionPipeAddress(runtimeId, options = {}) {
  return controlEndpointAddress(runtimeId, { ...options, prefix: "weft-session" });
}

/** Identity for a background worker's control endpoint. */
export function createControlIdentity({ storeAuthority, sessionId }, { randomId = randomUUID } = {}) {
  const clean = (value, name) => {
    const result = String(value ?? "").trim();
    if (!result) throw new Error(`${name} is required`);
    return result;
  };
  return Object.freeze({
    storeAuthority: clean(storeAuthority, "storeAuthority"),
    sessionId: clean(sessionId, "sessionId"),
    terminalInstanceId: randomId(),
    runtimeInstanceId: randomId(),
    generation: 1,
  });
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorResult(code, message) {
  return { ok: false, error: { code, message } };
}

export function controlAuth(identity, capability) {
  return Object.freeze({
    capability,
    storeAuthority: identity.storeAuthority,
    sessionId: identity.sessionId,
    runtimeInstanceId: identity.runtimeInstanceId,
    generation: identity.generation,
  });
}

function authenticate(request, identity, capability) {
  const auth = request?.auth;
  return Boolean(auth) &&
    secureEqual(auth.capability, capability()) &&
    auth.storeAuthority === identity().storeAuthority &&
    auth.sessionId === identity().sessionId &&
    auth.runtimeInstanceId === identity().runtimeInstanceId &&
    auth.generation === identity().generation;
}

function frame(value, maxFrameBytes) {
  const data = `${JSON.stringify({ version: CONTROL_FRAME_VERSION, ...value })}\n`;
  if (Buffer.byteLength(data) > maxFrameBytes) {
    return `${JSON.stringify({
      version: CONTROL_FRAME_VERSION,
      id: value.id ?? null,
      ...errorResult("RESPONSE_TOO_LARGE", "Control response exceeded its size limit."),
    })}\n`;
  }
  return data;
}

/**
 * Generic capability-authenticated control server. `identity` and `capability` may be values or
 * getters (a session rotates them on reload). `probe` is answered from `presence`.
 */
export async function createControlServer(
  {
    identity,
    capability,
    presence,
    handlers = {},
    endpoint,
  },
  { maxFrameBytes = MAX_CONTROL_FRAME_BYTES, connectionTimeoutMs = 5_000, keepAlive = false } = {},
) {
  const currentIdentity = typeof identity === "function" ? identity : () => identity;
  const currentCapability = typeof capability === "function" ? capability : () => capability;
  if (!currentIdentity() || !currentCapability()) throw new Error("identity and capability are required");
  const address = endpoint ?? controlEndpointAddress(currentIdentity().runtimeInstanceId);
  const sockets = new Set();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let received = false;
    let finished = false;
    const finish = (requestId, result) => {
      if (finished) return;
      finished = true;
      sockets.delete(socket);
      socket.setTimeout(0);
      socket.end(frame({ id: requestId ?? null, ...result }, maxFrameBytes));
    };
    socket.setTimeout(connectionTimeoutMs, () => {
      finish(null, errorResult("REQUEST_TIMEOUT", "Control request was incomplete."));
    });
    socket.on("data", async (chunk) => {
      if (received || finished) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrameBytes) {
        finish(null, errorResult("FRAME_TOO_LARGE", "Control request exceeded its size limit."));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      if (buffer.subarray(newline + 1).some((byte) => byte > 0x20)) {
        finish(null, errorResult("MALFORMED_FRAME", "One control request is allowed per connection."));
        return;
      }
      let request;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        finish(null, errorResult("MALFORMED_FRAME", "Control request was not valid JSON."));
        return;
      }
      const requestId = typeof request?.id === "string" ? request.id : null;
      received = true;
      if (request?.version !== CONTROL_FRAME_VERSION || !requestId || typeof request.command !== "string") {
        finish(requestId, errorResult("INVALID_REQUEST", "Control request was invalid or unsupported."));
        return;
      }
      if (!authenticate(request, currentIdentity, currentCapability)) {
        finish(requestId, errorResult("AUTH_FAILED", "Control capability or runtime identity is stale."));
        return;
      }
      try {
        let result;
        if (request.command === "probe" && typeof handlers.probe !== "function") {
          result = { presence: typeof presence === "function" ? presence() : presence ?? null };
        } else {
          const handler = Object.hasOwn(handlers, request.command) ? handlers[request.command] : null;
          if (typeof handler !== "function") {
            finish(requestId, errorResult("UNSUPPORTED_COMMAND", `No ${request.command} handler is registered.`));
            return;
          }
          result = await handler(request.payload ?? null, { identity: currentIdentity(), requestId });
        }
        finish(requestId, { ok: true, result: result ?? null });
      } catch (error) {
        finish(requestId, errorResult(error?.code ?? "COMMAND_FAILED", error?.message ?? "Control command failed."));
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  if (process.platform !== "win32") rmSync(address, { force: true });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
  if (!keepAlive) server.unref();
  return {
    endpoint: address,
    get closed() {
      return closed;
    },
    connectionCount() {
      return sockets.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (process.platform !== "win32") rmSync(address, { force: true });
    },
  };
}

/** Send one command. Rejects with `{ timeout: true }` on deadline; the command may still run. */
export async function sendControlCommand(
  { endpoint, auth, command, payload = null, id = `request-${randomUUID()}` },
  { maxFrameBytes = MAX_CONTROL_FRAME_BYTES, timeoutMs = SESSION_COMMAND_TIMEOUT_MS } = {},
) {
  if (typeof command !== "string" || !command) throw new Error("A control command is required");
  const data = `${JSON.stringify({ version: CONTROL_FRAME_VERSION, id, command, auth, payload })}\n`;
  if (Buffer.byteLength(data) > maxFrameBytes) throw new Error("Control request exceeds its size limit");
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () =>
      fail(Object.assign(new Error("Control endpoint timed out"), { timeout: true, code: "timeout" })));
    socket.on("connect", () => socket.write(data));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrameBytes) fail(new Error("Control response exceeds its size limit"));
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        reject(new Error("Control endpoint returned an incomplete frame"));
        return;
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (response.version !== CONTROL_FRAME_VERSION || response.id !== id) {
          reject(new Error("Control endpoint returned a mismatched response"));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error("Control endpoint returned malformed JSON"));
      }
    });
  });
}

// ---- session commands --------------------------------------------------------------------------

export class SessionControlError extends Error {
  constructor(code, message, { timeout = false } = {}) {
    super(message);
    this.code = code;
    this.timeout = timeout;
  }
}

/** Auth identity of a session record, as its control server checks it. */
export function sessionControlIdentity(record) {
  return {
    storeAuthority: record.session.storeAuthority,
    sessionId: record.session.sessionId,
    runtimeInstanceId: record.run.runtimeId,
    generation: record.run.generation,
  };
}

/** Remember results of keyed commands so a retried opId/requestId runs once. */
export function createIdempotencyCache(limit = 64) {
  const entries = new Map();
  return {
    run(key, fn) {
      if (!key) return fn();
      if (entries.has(key)) return entries.get(key);
      const pending = Promise.resolve().then(fn);
      entries.set(key, pending);
      pending.catch(() => entries.delete(key));
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      return pending;
    },
  };
}

/**
 * Session side: serve the commands in LLD §5.2. `handlers` implements them; `identity()` and
 * `capability()` are read per request because a reload rotates both.
 */
export async function startSessionControlServer({ identity, capability, pipe, handlers }, options = {}) {
  const cache = createIdempotencyCache();
  const keyed = (name, keyOf) => async (payload, context) => {
    const key = keyOf(payload);
    return cache.run(key ? `${name}:${key}` : null, () => handlers[name](payload ?? {}, context));
  };
  const wrapped = {
    probe: (payload, context) => handlers.probe(payload, context),
    activate: keyed("activate", (payload) => payload?.requestId),
    resetLink: keyed("resetLink", (payload) => payload?.opId),
    replaceController: keyed("replaceController", (payload) => payload?.opId),
    quiesce: keyed("quiesce", (payload) => payload?.opId),
    traffic: (payload, context) => handlers.traffic?.(payload, context) ?? { entries: [] },
    reloadExtension: keyed("reloadExtension", (payload) => payload?.opId),
  };
  return createControlServer({
    identity,
    capability,
    endpoint: pipe,
    handlers: Object.fromEntries(Object.entries(wrapped).filter(([name]) =>
      name === "traffic" || typeof handlers[name] === "function")),
  }, options);
}

/**
 * Station side: a client for one live record. Each call has a 5 s deadline; a timed-out call
 * rejects with `timeout: true` and must be treated as "unknown", never as "did not happen".
 */
export function createSessionControlClient(record, {
  baseDir,
  capability = null,
  send = sendControlCommand,
  timeoutMs = SESSION_COMMAND_TIMEOUT_MS,
} = {}) {
  const auth = () => controlAuth(sessionControlIdentity(record), capability ?? readSessionCapability(record.run.runtimeId, { baseDir }));
  return Object.freeze({
    record,
    async command(command, payload = null, options = {}) {
      let response;
      try {
        response = await send({ endpoint: record.control.pipe, auth: auth(), command, payload },
          { timeoutMs: options.timeoutMs ?? timeoutMs });
      } catch (error) {
        if (error?.timeout) throw new SessionControlError("timeout", `Session ${command} timed out.`, { timeout: true });
        throw new SessionControlError(error?.code ?? "unreachable", error?.message ?? `Session ${command} failed.`);
      }
      if (response?.ok !== true) {
        throw new SessionControlError(response?.error?.code ?? "command-failed", response?.error?.message ?? `Session ${command} failed.`);
      }
      return response.result ?? null;
    },
  });
}
