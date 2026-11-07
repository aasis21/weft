// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createManagement, ManagementError, validateManagementAction, withManagementLock } from "./management.mjs";
import { renderControlCenterPage } from "./controlCenterPage.mjs";
import { weftHome } from "./projects.mjs";
import { getProcessStartTime, verifyProcessIdentity } from "./processIdentity.mjs";

const exec = promisify(execFile);
const RECORD = "control-center.json";
const equal = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failure = (error) => ({
  code: error instanceof ManagementError ? error.code : "operation-failed",
  message: error instanceof ManagementError ? error.message : "Weft could not complete this operation. Check local configuration and workload status before retrying.",
});

async function readRecord(baseDir) {
  try { return JSON.parse(await readFile(join(baseDir, RECORD), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new ManagementError("invalid-ui-registry", "The local UI registry is unreadable. No process was contacted."); }
}
export async function inspectControlCenter({ baseDir = weftHome() } = {}) {
  const record = await readRecord(baseDir);
  if (!record) return null;
  let url;
  try { url = new URL(record.origin); } catch { throw new ManagementError("invalid-ui-registry", "Invalid local UI address."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash || !url.port ||
      !/^[a-f0-9]{64}$/.test(record.capability ?? "")) {
    throw new ManagementError("invalid-ui-registry", "Invalid local UI identity. No process was contacted.");
  }
  const proof = await verifyProcessIdentity(record);
  if (proof?.live === false) return null;
  if (proof?.live !== true) throw new ManagementError("ui-identity-uncertain", "The UI process identity could not be verified.");
  try {
    const response = await fetch(`${record.origin}/api/probe`, {
      headers: { Cookie: `weft_control=${record.capability}` }, signal: AbortSignal.timeout(2000),
    });
    const body = response.ok ? await response.json() : null;
    if (body?.pid !== record.pid || !equal(body?.instanceId, record.instanceId)) {
      throw new ManagementError("ui-identity-mismatch", "The local UI endpoint did not prove its identity.");
    }
  } catch (error) {
    if (error instanceof ManagementError) throw error;
    throw new ManagementError("ui-unresponsive", "The UI process is running but not responding. Do not start a duplicate; retry after checking its status.");
  }
  return record;
}

export async function openControlCenter({
  baseDir = weftHome(), cliPath, launchBrowser = true, timeoutMs = 20_000,
  spawnHost = (args, options) => spawn(process.execPath, args, options),
  openBrowser = openControlCenterBrowser,
} = {}) {
  baseDir = resolve(baseDir);
  const record = await withManagementLock(baseDir, async () => {
    const existing = await inspectControlCenter({ baseDir });
    if (existing) return existing;
    const child = spawnHost([resolve(cliPath), "__ui-host", baseDir], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const ready = await inspectControlCenter({ baseDir });
      if (ready) return ready;
      await sleep(100);
    }
    throw new ManagementError("ui-startup-timeout", "Control Center did not become ready. Check the installed bundle and retry; no workloads were started.");
  });
  if (launchBrowser) await openBrowser(`${record.origin}/open/${record.capability}`);
  return { origin: record.origin, pid: record.pid };
}

export async function openControlCenterBrowser(url) {
  if (process.platform === "win32") {
    await exec("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
  } else {
    await exec(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  }
}

export async function stopControlCenter({ baseDir = weftHome() } = {}) {
  const record = await inspectControlCenter({ baseDir });
  if (!record) return { state: "stopped" };
  const response = await fetch(`${record.origin}/api/close`, {
    method: "POST", headers: { Cookie: `weft_control=${record.capability}`, Origin: record.origin, "Content-Type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new ManagementError("ui-busy", "Control Center has an active operation. Wait for it to finish before stopping the UI host.");
  return { state: "stopped" };
}

export async function createControlCenterHost({
  baseDir = weftHome(), cliPath, management = createManagement({ baseDir, cliPath }),
  renderPage = renderControlCenterPage, idleMs = 5 * 60_000, publish = true,
  getStartTime = getProcessStartTime, now = Date.now,
} = {}) {
  baseDir = resolve(baseDir);
  const capability = randomBytes(32).toString("hex");
  const instanceId = randomBytes(32).toString("hex");
  const operations = new Map();
  let origin, lastActivity = now(), closing = false;
  const cookie = `weft_control=${capability}; HttpOnly; SameSite=Strict; Path=/`;
  const active = () => [...operations.values()].some((op) => op.state === "running");
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent && !res.destroyed) json(res, error instanceof ManagementError ? 400 : 500, { error: failure(error) });
      else res.destroy();
    });
  });
  function json(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    if (req.headers["content-type"] !== "application/json") throw new ManagementError("invalid-input", "JSON is required.");
    if (Number(req.headers["content-length"]) > 64 * 1024) throw new ManagementError("too-large", "Management request exceeds the size limit.");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new ManagementError("too-large", "Management request exceeds the size limit.");
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ManagementError("invalid-input", "Invalid JSON request."); }
  }
  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.headers.host !== new URL(origin).host ||
        req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: { code: "forbidden", message: "Only the local Control Center can access this endpoint." } });
    const url = new URL(req.url, origin);
    if (req.method === "GET" && equal(url.pathname, `/open/${capability}`)) {
      lastActivity = now();
      res.writeHead(303, { "Set-Cookie": cookie, Location: "/" });
      return res.end();
    }
    const token = req.headers.cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith("weft_control="))?.slice(13);
    if (!equal(token, capability)) return json(res, 401, { error: { code: "unauthorized", message: "Open Control Center using weft ui to authorize this browser." } });
    if (closing) return json(res, 503, { error: { code: "closing", message: "Control Center is closing. Reopen it with weft ui." } });
    lastActivity = now();
    if (req.method === "GET") {
      if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(renderPage()); }
      if (url.pathname === "/api/probe") return json(res, 200, { pid: process.pid, instanceId });
      if (url.pathname === "/api/state") return json(res, 200, await management.state());
      if (url.pathname === "/api/pairing") return json(res, 200, await management.pairing(url.searchParams.get("runtimeId") ?? undefined));
      if (url.pathname === "/api/update") return json(res, 200, await management.update());
      if (url.pathname.startsWith("/api/operations/")) {
        const operation = operations.get(url.pathname.slice("/api/operations/".length));
        return json(res, operation ? 200 : 404, operation ? publicOperation(operation) : { error: { code: "unknown-operation", message: "Operation result is unavailable. Refresh actual state; do not automatically repeat the action." } });
      }
    }
    if (req.method === "POST") {
      if (req.headers.origin !== origin) return json(res, 403, { error: { code: "forbidden", message: "Same-origin confirmation is required." } });
      const input = await body(req);
      if (url.pathname === "/api/close") {
        if (active()) return json(res, 409, { error: { code: "operation-busy", message: "An operation is still running." } });
        json(res, 200, { state: "stopped" });
        setTimeout(() => void close(), 50);
        return;
      }
      if (url.pathname === "/api/operations") {
        if (!input || typeof input !== "object" || Object.keys(input).some((k) => !["id", "action", "payload"].includes(k)) ||
            !/^[a-f0-9-]{36}$/i.test(input.id ?? "")) throw new ManagementError("invalid-input", "An operation identity is required.");
        validateManagementAction(input.action, input.payload);
        const signature = JSON.stringify({ action: input.action, payload: input.payload });
        const existing = operations.get(input.id);
        if (existing) {
          if (existing.signature !== signature) return json(res, 409, { error: { code: "request-conflict", message: "This request identity was already used for another action." } });
          return json(res, 202, publicOperation(existing));
        }
        if (operations.size >= 128) throw new ManagementError("operation-busy", "This UI host reached its operation limit. Finish active work, then reopen the UI host. Prior request identities are not replayed.");
        const operation = { id: input.id, state: "running", signature };
        operations.set(input.id, operation);
        void Promise.resolve().then(() => management.execute(input.action, input.payload, { operationId: input.id }))
          .then((result) => { operation.state = "succeeded"; operation.result = result; })
          .catch((error) => { operation.state = "failed"; operation.error = failure(error); })
          .finally(() => { lastActivity = now(); });
        return json(res, 202, publicOperation(operation));
      }
    }
    return json(res, 404, { error: { code: "not-found", message: "Unknown local management endpoint." } });
  }
  function publicOperation(operation) {
    const { signature: _signature, ...result } = operation;
    return result;
  }
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  origin = `http://127.0.0.1:${server.address().port}`;
  if (publish) {
    try {
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      const tmp = join(baseDir, `${RECORD}.${instanceId}.tmp`);
      await writeFile(tmp, JSON.stringify({ origin, capability, instanceId, pid: process.pid, processStartedAt: await getStartTime(process.pid) }), { mode: 0o600 });
      await rename(tmp, join(baseDir, RECORD));
    } catch (error) { await new Promise((done) => server.close(done)); throw error; }
  }
  const idleTimer = setInterval(() => {
    if (!active() && now() - lastActivity > idleMs) void close();
  }, Math.min(idleMs, 10_000));
  idleTimer.unref();
  async function close() {
    if (closing || active()) return false;
    closing = true;
    clearInterval(idleTimer);
    if (publish) {
      const record = await readRecord(baseDir);
      if (record?.instanceId === instanceId) await unlink(join(baseDir, RECORD));
    }
    server.closeIdleConnections();
    await new Promise((done) => server.close(done));
    return true;
  }
  return { origin, url: `${origin}/open/${capability}`, close, server };
}
