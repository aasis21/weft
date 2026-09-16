// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";

export const LIFECYCLE_ENDPOINT_VERSION = 1;
export const MAX_LIFECYCLE_FRAME_BYTES = 64 * 1_024;
export const LIFECYCLE_COMMANDS = Object.freeze([
  "probe",
  "activate",
  "status",
  "replace-controller",
  "quiesce",
]);

function privateMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on Windows.
  }
}

function endpointStem(runtimeInstanceId) {
  const value = String(runtimeInstanceId ?? "").trim();
  if (!value) throw new Error("runtimeInstanceId is required");
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function runtimeEndpointAddress(
  runtimeInstanceId,
  { baseDir, platform = process.platform } = {},
) {
  const stem = endpointStem(runtimeInstanceId);
  if (platform === "win32") return `\\\\.\\pipe\\weft-runtime-${stem}`;
  const dir = join(weftHome(baseDir), "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateMode(dir, 0o700);
  return join(dir, `${stem}.sock`);
}

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorResult(code, message) {
  return { ok: false, error: { code, message } };
}

function authenticate(request, identity, capability) {
  const auth = request?.auth;
  return auth &&
    secureEqual(auth.capability, capability) &&
    auth.storeAuthority === identity.storeAuthority &&
    auth.sessionId === identity.sessionId &&
    auth.runtimeInstanceId === identity.runtimeInstanceId &&
    auth.generation === identity.generation;
}

function frame(value, maxFrameBytes) {
  const data = `${JSON.stringify({ version: LIFECYCLE_ENDPOINT_VERSION, ...value })}\n`;
  if (Buffer.byteLength(data) > maxFrameBytes) {
    return `${JSON.stringify({
      version: LIFECYCLE_ENDPOINT_VERSION,
      ...errorResult("RESPONSE_TOO_LARGE", "Lifecycle response exceeded its size limit."),
    })}\n`;
  }
  return data;
}

function requestFrame(value, maxFrameBytes) {
  const data = `${JSON.stringify({ version: LIFECYCLE_ENDPOINT_VERSION, ...value })}\n`;
  if (Buffer.byteLength(data) > maxFrameBytes) throw new Error("Lifecycle request exceeds its size limit");
  return data;
}

export async function createLifecycleEndpoint(
  {
    identity,
    capability,
    presence,
    handlers = {},
    endpoint = runtimeEndpointAddress(identity?.runtimeInstanceId),
  },
  { maxFrameBytes = MAX_LIFECYCLE_FRAME_BYTES, connectionTimeoutMs = 5_000 } = {},
) {
  if (!identity || !capability) throw new Error("identity and capability are required");
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
      finish(null, errorResult("REQUEST_TIMEOUT", "Lifecycle request was incomplete."));
    });
    socket.on("data", async (chunk) => {
      if (received || finished) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrameBytes) {
        finish(null, errorResult("FRAME_TOO_LARGE", "Lifecycle request exceeded its size limit."));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      if (buffer.subarray(newline + 1).some((byte) => byte > 0x20)) {
        finish(null, errorResult("MALFORMED_FRAME", "One lifecycle request is allowed per connection."));
        return;
      }
      let request;
      try {
        request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        finish(null, errorResult("MALFORMED_FRAME", "Lifecycle request was not valid JSON."));
        return;
      }
      const requestId = typeof request?.id === "string" ? request.id : null;
      received = true;
      if (request?.version !== LIFECYCLE_ENDPOINT_VERSION || !requestId || !LIFECYCLE_COMMANDS.includes(request.command)) {
        finish(requestId, errorResult("INVALID_REQUEST", "Lifecycle request was invalid or unsupported."));
        return;
      }
      if (!authenticate(request, identity, capability)) {
        finish(requestId, errorResult("AUTH_FAILED", "Lifecycle capability or runtime identity is stale."));
        return;
      }
      try {
        let result;
        if (request.command === "probe") {
          result = { presence: presence?.() ?? presence ?? null };
        } else {
          const handler = handlers[request.command];
          if (typeof handler !== "function") {
            finish(requestId, errorResult("UNSUPPORTED_COMMAND", `No ${request.command} handler is registered.`));
            return;
          }
          result = await handler(request.payload ?? null, { identity, requestId });
        }
        finish(requestId, { ok: true, result: result ?? null });
      } catch (error) {
        finish(requestId, errorResult(error?.code ?? "COMMAND_FAILED", error?.message ?? "Lifecycle command failed."));
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  if (process.platform !== "win32") rmSync(endpoint, { force: true });
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
    server.listen(endpoint);
  });
  server.unref();
  return {
    endpoint,
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
      if (process.platform !== "win32") rmSync(endpoint, { force: true });
    },
  };
}

export function lifecycleAuth(identity, capability) {
  return Object.freeze({
    capability,
    storeAuthority: identity.storeAuthority,
    sessionId: identity.sessionId,
    runtimeInstanceId: identity.runtimeInstanceId,
    generation: identity.generation,
  });
}

export async function sendLifecycleCommand(
  { endpoint, auth, command, payload = null, id = `request-${Date.now()}` },
  { maxFrameBytes = MAX_LIFECYCLE_FRAME_BYTES, timeoutMs = 5_000 } = {},
) {
  if (!LIFECYCLE_COMMANDS.includes(command)) throw new Error(`Unsupported lifecycle command: ${command}`);
  const request = requestFrame({ id, command, auth, payload }, maxFrameBytes);
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
    socket.setTimeout(timeoutMs, () => fail(new Error("Lifecycle endpoint timed out")));
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrameBytes) fail(new Error("Lifecycle response exceeds its size limit"));
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        reject(new Error("Lifecycle endpoint returned an incomplete frame"));
        return;
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (response.version !== LIFECYCLE_ENDPOINT_VERSION || response.id !== id) {
          reject(new Error("Lifecycle endpoint returned a mismatched response"));
          return;
        }
        resolve(response);
      } catch {
        reject(new Error("Lifecycle endpoint returned malformed JSON"));
      }
    });
  });
}
