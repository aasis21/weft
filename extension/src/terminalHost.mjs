// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { release } from "node:os";
import headless from "@xterm/headless";
import serialization from "@xterm/addon-serialize";
import { terminalState, terminalOutput, terminalSnapshot } from "@aasis21/weft-shared";

export const TERMINAL_LIMITS = Object.freeze({
  minCols: 20, maxCols: 240, minRows: 5, maxRows: 100,
  inputBytes: 16_384, outputBytes: 16_384, pendingChars: 262_144,
  snapshotBytes: 128 * 1024, socketBytes: 2_097_152, scrollback: 500,
});
const ACTIONS = new Set(["open", "attach", "detach", "input", "resize", "claim", "close"]);
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function outputChunkEnd(data, ending) {
  let end = 0, bytes = 0;
  while (end < data.length) {
    const codepoint = data.codePointAt(end);
    // A PTY callback can split a surrogate pair. Retain its leading half until the
    // next callback rather than emitting two corrupted frontend characters.
    if (!ending && end === data.length - 1 && codepoint >= 0xd800 && codepoint <= 0xdbff) break;
    const size = codepoint <= 0x7f ? 1 : codepoint <= 0x7ff ? 2 : codepoint <= 0xffff ? 3 : 4;
    if (bytes + size > TERMINAL_LIMITS.outputBytes) break;
    bytes += size;
    end += codepoint > 0xffff ? 2 : 1;
  }
  return end;
}

export function validateTerminalRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid terminal request.");
  const { requestId, action, terminalId, projectName, data, inputSeq, cols, rows } = request;
  if (typeof requestId !== "string" || !ID.test(requestId)) throw new Error("Invalid terminal request ID.");
  if (!ACTIONS.has(action)) throw new Error("Unknown terminal action.");
  const fields = new Set(["requestId", "action", "terminalId"]);
  if (action === "open") fields.add("projectName");
  if (action === "input") { fields.add("data"); fields.add("inputSeq"); }
  if (action === "resize" || action === "open" || action === "claim") { fields.add("cols"); fields.add("rows"); }
  if (Object.keys(request).some((key) => !fields.has(key))) throw new Error("Unexpected terminal request field.");
  if (action !== "open" && (typeof terminalId !== "string" || !GENERATION.test(terminalId))) {
    throw new Error("A valid terminal identity is required. Open or reconnect first.");
  }
  if (terminalId !== undefined && (typeof terminalId !== "string" || !GENERATION.test(terminalId))) {
    throw new Error("Invalid terminal identity.");
  }
  if (projectName !== undefined && (typeof projectName !== "string" || projectName.length > 128 || !projectName)) {
    throw new Error("Invalid registered project name.");
  }
  if (action === "input") {
    if (typeof data !== "string" || !data.length || Buffer.byteLength(data) > TERMINAL_LIMITS.inputBytes) {
      throw new Error("Terminal input must contain between 1 and 16384 bytes.");
    }
    if (!Number.isSafeInteger(inputSeq) || inputSeq < 1) throw new Error("Invalid terminal input sequence.");
  }
  if (action === "resize" || cols !== undefined || rows !== undefined) validateDimensions(cols, rows);
  return request;
}

function validateDimensions(cols, rows) {
  const limits = TERMINAL_LIMITS;
  if (!Number.isInteger(cols) || cols < limits.minCols || cols > limits.maxCols ||
      !Number.isInteger(rows) || rows < limits.minRows || rows > limits.maxRows) {
    throw new Error("Terminal dimensions must be 20-240 columns and 5-100 rows.");
  }
}

export function terminalCliPath(moduleUrl = import.meta.url) {
  const dir = dirname(fileURLToPath(moduleUrl));
  return existsSync(join(dir, "weft.mjs")) ? join(dir, "weft.mjs") : join(dir, "..", "bin", "weft.mjs");
}

export async function loadTerminalRuntime() {
  if (process.platform !== "win32" || Number(release().split(".")[2] ?? 0) < 18309) {
    throw new Error("Shared terminal requires Windows 10 build 18309 or newer with ConPTY.");
  }
  const require = createRequire(import.meta.url);
  let pty;
  try {
    pty = require("node-pty");
    const native = require("node-pty/lib/utils").loadNativeModule("conpty");
    const nativeDirectory = join(dirname(require.resolve("node-pty/lib/utils")), native.dir);
    if (!existsSync(join(nativeDirectory, "conpty", "conpty.dll")) ||
        !existsSync(join(nativeDirectory, "conpty", "OpenConsole.exe"))) throw new Error("Missing ConPTY runtime.");
  } catch {
    throw new Error("Terminal runtime is unavailable. Older updaters install JavaScript only: run `weft update` once more to install native assets, then restart Station. If that fails, reinstall the complete Weft Windows release.");
  }
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(shell) || !existsSync(terminalCliPath())) throw new Error("The installed shell or Weft attach client is missing.");
  return { pty, Terminal: headless.Terminal, SerializeAddon: serialization.SerializeAddon, shell };
}

export function launchVisibleTerminal({ pipe, token, terminalId, cwd }) {
  // Node's detached Windows spawn uses DETACHED_PROCESS (no console). A hidden, fixed
  // Start-Process launcher creates a real console containing only node + weft attach.
  // Credentials travel exclusively in inherited environment, never script text or argv.
  const launcher = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = '$ErrorActionPreference="Stop"; $arguments=\'"\' + $env:WEFT_TERMINAL_CLI + \'" terminal attach\'; ' +
    '$p=Start-Process -FilePath $env:WEFT_TERMINAL_NODE -ArgumentList $arguments -PassThru -Wait; exit $p.ExitCode';
  const child = spawn(launcher, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], shell: false,
    env: {
      ...process.env, WEFT_TERMINAL_PIPE: pipe, WEFT_TERMINAL_TOKEN: token, WEFT_TERMINAL_ID: terminalId,
      WEFT_TERMINAL_NODE: process.execPath, WEFT_TERMINAL_CLI: terminalCliPath(),
    },
  });
  return child;
}

export function createTerminalHost({
  allowTerminal = false, projectsApi, send = async () => {}, lifecycle = () => {},
  loadRuntime = loadTerminalRuntime, launchVisible = launchVisibleTerminal, attachTimeoutMs = 15_000,
  sendTimeoutMs = 5_000, drainTimeoutMs = 2_000,
} = {}) {
  let runtime = null, supportError = null, initialized = false, stopped = false;
  let current = null, lastClosed = null, queue = Promise.resolve(), queued = 0;
  let phoneSubscribed = false, sendChain = Promise.resolve(), sendBytes = 0, phoneEpoch = 0;

  async function initialize() {
    if (initialized) return;
    initialized = true;
    if (!allowTerminal) return;
    try { runtime = await loadRuntime(); }
    catch (error) { supportError = error.message; lifecycle({ event: "unavailable" }); }
  }

  function enqueue(operation) {
    if (queued >= 128) return Promise.reject(new Error("Terminal is busy. Reconnect before sending more input."));
    queued++;
    const result = queue.then(operation);
    queue = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }

  function state(requestId = null, status = current?.status ?? "closed", error = null, terminal = current) {
    return terminalState({
      requestId, terminalId: terminal?.id ?? null, status, shell: terminal ? "Windows PowerShell" : null,
      cwd: terminal?.cwd ?? null, cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24,
      owner: status === "closed" ? null : terminal?.owner ?? null, nextInputSeq: terminal?.nextInputSeq ?? 1, error,
    });
  }

  function sendPhone(message, { force = false } = {}) {
    if (!force && !phoneSubscribed) return Promise.resolve();
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (sendBytes + bytes > TERMINAL_LIMITS.socketBytes) {
      disconnectPhone();
      lifecycle({ event: "phone_backpressure" });
      return Promise.resolve();
    }
    const epoch = phoneEpoch;
    sendBytes += bytes;
    const pending = sendChain.then(async () => {
      if (epoch !== phoneEpoch) return;
      let timer;
      try {
        await Promise.race([
          send(message),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Terminal delivery timed out.")), sendTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    });
    sendChain = pending.catch(() => {
      if (epoch === phoneEpoch) disconnectPhone();
      lifecycle({ event: "phone_delivery_failed" });
    }).finally(() => { sendBytes -= bytes; });
    return sendChain;
  }

  function localSend(terminal, message) {
    const socket = terminal.socket;
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > TERMINAL_LIMITS.socketBytes) {
      socket.destroy();
      return;
    }
    socket.write(`${JSON.stringify(message)}\n`);
  }

  function broadcastState(requestId = null) {
    const message = state(requestId);
    localSend(current ?? {}, message);
    return sendPhone(message, { force: requestId !== null });
  }

  async function flush(terminal) {
    if (terminal.flushing) return terminal.flushing;
    terminal.flushing = (async () => {
      while (terminal.pending && current === terminal && terminal.status !== "closed" && !terminal.outputAborted) {
        const end = outputChunkEnd(terminal.pending, terminal.ending);
        if (end === 0) break;
        const data = terminal.pending.slice(0, end);
        terminal.pending = terminal.pending.slice(end);
        let timer;
        try {
          await new Promise((resolve, reject) => {
            terminal.cancelWrite = () => reject(new Error("Terminal screen processing timed out."));
            timer = setTimeout(terminal.cancelWrite, drainTimeoutMs);
            terminal.screen.write(data, resolve);
          });
        } finally {
          clearTimeout(timer);
          terminal.cancelWrite = null;
        }
        if (current !== terminal || terminal.status === "closed" || terminal.outputAborted) break;
        terminal.seq++;
        terminal.totalChars += data.length;
        terminal.truncated ||= terminal.screen.buffer.active.baseY >= TERMINAL_LIMITS.scrollback;
        const message = terminalOutput({ terminalId: terminal.id, seq: terminal.seq, data });
        localSend(terminal, message);
        void sendPhone(message);
      }
      if (terminal.paused && current === terminal && terminal.status !== "closed" && !terminal.ending) {
        terminal.paused = false;
        terminal.pty.resume();
      }
    })().finally(() => { terminal.flushing = null; });
    return terminal.flushing;
  }

  async function snapshot(terminal, local = false) {
    await flush(terminal);
    if (current !== terminal || terminal.status === "closed" || terminal.ending) return;
    let scrollback = TERMINAL_LIMITS.scrollback;
    let truncated = Boolean(terminal.truncated) || terminal.totalChars > terminal.cols * (terminal.rows + TERMINAL_LIMITS.scrollback);
    let message;
    while (true) {
      const data = terminal.serializer.serialize({ scrollback });
      message = terminalSnapshot({ terminalId: terminal.id, seq: terminal.seq, data, cols: terminal.cols, rows: terminal.rows, truncated });
      // Bound the entire escaped envelope, not raw VT characters. AES-GCM/base64 and
      // broadcast framing must still fit Supabase Free's 256 KB message limit.
      if (Buffer.byteLength(JSON.stringify(message)) <= TERMINAL_LIMITS.snapshotBytes) break;
      if (scrollback === 0) {
        const error = new Error("Terminal screen exceeds the relay snapshot limit. Reduce the terminal size on the laptop or close and reopen it.");
        error.code = "TERMINAL_SNAPSHOT_TOO_LARGE";
        throw error;
      }
      scrollback = Math.floor(scrollback / 2);
      truncated = true;
    }
    if (local) localSend(terminal, message);
    else await sendPhone(message);
  }

  function resize(terminal, cols, rows) {
    if (cols === undefined) return false;
    validateDimensions(cols, rows);
    if (terminal.cols === cols && terminal.rows === rows) return false;
    terminal.pty.resize(cols, rows);
    terminal.screen.resize(cols, rows);
    terminal.cols = cols;
    terminal.rows = rows;
    return true;
  }

  async function closeTerminal(terminal = current, error = null) {
    if (!terminal || terminal.ending) return terminal?.closing;
    terminal.ending = true;
    terminal.closing = (async () => {
      clearTimeout(terminal.flushTimer);
      clearTimeout(terminal.attachTimer);
      terminal.rejectAttach?.(new Error(error ?? "Terminal closed before the laptop attached."));
      terminal.rejectAttach = null;
      terminal.dataSubscription?.dispose();
      terminal.exitSubscription?.dispose();
      // node-pty closes ConPTY and terminates its owned process list, including descendants.
      let cleanupError = null;
      try {
        terminal.pty?.kill();
        // node-pty 1.1.0's ConPTY DLL path disposes its drain worker only on *later*
        // output. An idle shell has no later output, leaving its worker/server alive.
        // Explicitly start that same bounded drain on close; the pinned runtime's
        // real-process integration test guards this compatibility workaround.
        terminal.pty?._agent?._conoutSocketWorker?.dispose();
      } catch { cleanupError = "The owned terminal process could not be stopped."; }
      let drainTimer;
      try {
        await Promise.race([
          flush(terminal),
          new Promise((_, reject) => {
            drainTimer = setTimeout(() => {
              terminal.outputAborted = true;
              terminal.cancelWrite?.();
              reject(new Error("Terminal output drain timed out."));
            }, drainTimeoutMs);
          }),
        ]);
      } catch {
        terminal.outputAborted = true;
        cleanupError ??= "Final terminal output could not be drained before shutdown.";
      } finally {
        clearTimeout(drainTimer);
      }
      terminal.status = "closed";
      localSend(terminal, state(null, "closed", error ?? cleanupError, terminal));
      const delivered = sendPhone(state(null, "closed", error ?? cleanupError, terminal));
      if (terminal.socket && !terminal.socket.destroyed) {
        await new Promise((resolve) => {
          const socket = terminal.socket;
          const finish = () => { clearTimeout(timer); socket.removeListener("close", finish); resolve(); };
          const timer = setTimeout(finish, drainTimeoutMs);
          socket.once("close", finish);
          socket.end(finish);
        });
      }
      for (const socket of terminal.sockets ?? []) socket.destroy();
      terminal.server?.close();
      if (terminal.child && terminal.child.exitCode === null && terminal.child.pid) {
        const result = spawnSync("taskkill.exe", ["/PID", String(terminal.child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore", timeout: 5000,
        });
        if (result.error) cleanupError = "The owned laptop terminal launcher could not be stopped.";
      }
      let deliveryTimer;
      try {
        await Promise.race([
          delivered,
          new Promise((resolve) => {
            deliveryTimer = setTimeout(() => {
              disconnectPhone();
              lifecycle({ event: "close_delivery_timeout" });
              resolve();
            }, sendTimeoutMs);
          }),
        ]);
      } finally { clearTimeout(deliveryTimer); }
      terminal.screen?.dispose();
      terminal.pending = "";
      lastClosed = {
        id: terminal.id, cwd: terminal.cwd, cols: terminal.cols, rows: terminal.rows,
        nextInputSeq: terminal.nextInputSeq, owner: null,
      };
      if (current === terminal) current = null;
      lifecycle({ event: cleanupError ? "cleanup_failed" : "closed" });
      if (cleanupError) throw new Error(cleanupError);
    })();
    return terminal.closing;
  }

  async function startIpc(terminal) {
    const token = randomBytes(32).toString("hex");
    const pipe = `\\\\.\\pipe\\weft-terminal-${process.pid}-${randomUUID()}`;
    terminal.sockets = new Set();
    const attached = new Promise((resolve, reject) => {
      terminal.resolveAttach = resolve;
      terminal.rejectAttach = reject;
      terminal.attachTimer = setTimeout(() => reject(new Error("The visible laptop terminal did not attach. Check the interactive Windows desktop and reinstall Weft if needed.")), attachTimeoutMs);
    });
    // Attach can fail while the server is still starting; retain that failure without an
    // unhandled rejection reaching Station's generic exception logger.
    attached.catch(() => {});
    const server = createServer((socket) => {
      if (terminal.sockets.size >= 8) { socket.destroy(); return; }
      terminal.sockets.add(socket);
      let buffer = "", authenticated = false;
      socket.setEncoding("utf8");
      socket.setTimeout(5_000, () => { if (!authenticated) socket.destroy(); });
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        terminal.sockets.delete(socket);
        if (terminal.socket === socket && current === terminal && terminal.status !== "closed") {
          void closeTerminal(terminal).catch(() => lifecycle({ event: "cleanup_failed" }));
        }
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > (authenticated ? 65_536 : 4_096)) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { socket.destroy(); return; }
          if (!authenticated) {
            const supplied = typeof message?.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
            const expected = Buffer.from(token);
            if (message?.type !== "hello" || message.terminalId !== terminal.id || terminal.socket ||
                supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
              socket.destroy(); return;
            }
            authenticated = true;
            socket.setTimeout(0);
            terminal.socket = socket;
            clearTimeout(terminal.attachTimer);
            terminal.rejectAttach = null;
            terminal.resolveAttach();
          } else {
            const rejectLocal = () => {
              localSend(terminal, state(null, "error", "Local terminal input was rejected. Reconnect or take control."));
            };
            if (current !== terminal || terminal.status !== "open" || terminal.ending) continue;
            // Input mutates the PTY synchronously. It must not queue behind a remote
            // acknowledgment (including a phone request already awaiting delivery).
            if (message?.type === "input" || message?.type === "resize") {
              try {
                if (message.type === "input") {
                  if (typeof message.data !== "string" || !message.data.length ||
                      Buffer.byteLength(message.data) > TERMINAL_LIMITS.inputBytes) throw new Error("Invalid local input.");
                  let changed = false;
                  if (message.claim === true) {
                    changed = resize(terminal, message.cols, message.rows) || terminal.owner !== "laptop";
                    terminal.owner = "laptop";
                  }
                  if (terminal.owner !== "laptop") continue;
                  terminal.pty.write(message.data);
                  if (changed) void broadcastState();
                } else if (terminal.owner === "laptop" && resize(terminal, message.cols, message.rows)) {
                  void broadcastState();
                }
              } catch { rejectLocal(); }
              continue;
            }
            void enqueue(async () => {
              if (current !== terminal || terminal.status !== "open" || terminal.ending) return;
              if (message?.type === "snapshot") {
                await snapshot(terminal, true);
              } else if (message?.type === "close") {
                await closeTerminal(terminal);
              } else {
                throw new Error("Invalid local terminal request.");
              }
            }).catch(rejectLocal);
          }
        }
      });
    });
    terminal.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", () => { void closeTerminal(terminal, "Local terminal IPC failed.").catch(() => lifecycle({ event: "cleanup_failed" })); });
    terminal.child = launchVisible({ pipe, token, terminalId: terminal.id, cwd: terminal.cwd });
    terminal.child.stderr?.resume();
    terminal.child.once("error", () => terminal.rejectAttach?.(new Error("Could not launch the visible laptop terminal.")));
    terminal.child.once("exit", () => {
      terminal.rejectAttach?.(new Error("The visible laptop terminal exited before attaching."));
      if (terminal.status === "open") void closeTerminal(terminal).catch(() => lifecycle({ event: "cleanup_failed" }));
    });
    await attached;
  }

  async function open(request) {
    if (current?.ending) await current.closing;
    if (current) {
      if (request.terminalId && request.terminalId !== current.id) throw new Error("This terminal has been replaced. Reconnect to the current terminal.");
      phoneSubscribed = true;
      resize(current, request.cols, request.rows);
      current.owner = "phone";
      await broadcastState(request.requestId);
      await snapshot(current);
      return;
    }
    if (request.terminalId) throw new Error("That terminal has ended. Open a new terminal explicitly.");
    const projects = await projectsApi.listProjects();
    const project = projects.find((entry) => entry.default === true || entry.isDefault === true);
    if (!project || (request.projectName !== undefined && request.projectName !== project.name)) {
      throw new Error("Register and select a default project on the laptop with weft add-project and weft set-default.");
    }
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) throw new Error("The registered default workspace is unavailable on the laptop.");
    const terminal = {
      id: randomUUID(), status: "opening", owner: "phone", nextInputSeq: 1,
      cols: request.cols ?? 80, rows: request.rows ?? 24, projectName: project.name, cwd: project.path,
      seq: 0, totalChars: 0, pending: "", paused: false,
    };
    current = terminal;
    phoneSubscribed = true;
    await broadcastState(request.requestId);
    try {
      if (stopped || terminal.ending || current !== terminal) throw new Error("Station is shutting down.");
      terminal.screen = new runtime.Terminal({ cols: terminal.cols, rows: terminal.rows, scrollback: TERMINAL_LIMITS.scrollback, allowProposedApi: true });
      terminal.serializer = new runtime.SerializeAddon();
      terminal.screen.loadAddon(terminal.serializer);
      const env = { ...process.env, TERM: "xterm-256color" };
      for (const key of Object.keys(env)) if (key.startsWith("WEFT_TERMINAL_")) delete env[key];
      terminal.pty = runtime.pty.spawn(runtime.shell, ["-NoLogo", "-NoProfile"], {
        cwd: terminal.cwd, cols: terminal.cols, rows: terminal.rows, name: "xterm-256color",
        env, useConpty: true, useConptyDll: true,
      });
      terminal.dataSubscription = terminal.pty.onData((data) => {
        if (terminal.status === "closed" || terminal.ending) return;
        if (terminal.pending.length + data.length > TERMINAL_LIMITS.pendingChars) {
          void closeTerminal(terminal, "Terminal output exceeded the safety buffer.").catch(() => lifecycle({ event: "cleanup_failed" }));
          return;
        }
        terminal.pending += data;
        if (terminal.pending.length > TERMINAL_LIMITS.pendingChars / 2 && !terminal.paused) {
          terminal.paused = true; terminal.pty.pause();
        }
        if (!terminal.flushTimer) terminal.flushTimer = setTimeout(() => {
          terminal.flushTimer = null;
          void flush(terminal).catch(() => { void closeTerminal(terminal, "Terminal output processing failed.").catch(() => lifecycle({ event: "cleanup_failed" })); });
        }, 16);
      });
      terminal.exitSubscription = terminal.pty.onExit(() => {
        void closeTerminal(terminal).catch(() => lifecycle({ event: "cleanup_failed" }));
      });
      await startIpc(terminal);
      if (current !== terminal || terminal.status === "closed") throw new Error("The shell exited while opening.");
      terminal.status = "open";
      await broadcastState(request.requestId);
      await snapshot(terminal, true);
      await snapshot(terminal);
      lifecycle({ event: "opened" });
    } catch (error) {
      await closeTerminal(terminal);
      // Native launch errors can contain executable paths; return only this fixed message.
      throw new Error(error.message?.startsWith("The visible") || error.message?.startsWith("Could not launch") ?
        error.message : "The shell or visible terminal could not start. Check the installed Windows terminal runtime and desktop.");
    }
  }

  async function handle(request) {
    const requestId = typeof request?.requestId === "string" && ID.test(request.requestId) ? request.requestId : null;
    try {
      return await enqueue(async () => {
        await initialize();
        if (!allowTerminal) throw new Error("Remote shell access is disabled. Set terminal.enabled to true in ~/.weft/weft.config.json and restart Station.");
        if (!runtime) throw new Error(supportError);
        if (stopped) throw new Error("Station is shutting down.");
        validateTerminalRequest(request);
        if (request.action === "open") return open(request);
        if (request.action === "close" && request.terminalId === lastClosed?.id) {
          await sendPhone(state(requestId, "closed", null, lastClosed), { force: true });
          return;
        }
        const terminal = current;
        if (!terminal || terminal.id !== request.terminalId || terminal.status !== "open" || terminal.ending) {
          throw new Error("This terminal has ended or been replaced. Open or reconnect; do not resend previous commands.");
        }
        switch (request.action) {
          case "attach":
            phoneSubscribed = true;
            await broadcastState(requestId);
            await snapshot(terminal);
            return;
          case "detach":
            await broadcastState(requestId);
            disconnectPhone();
            return;
          case "claim":
            terminal.owner = "phone";
            resize(terminal, request.cols, request.rows);
            break;
          case "input":
            if (request.inputSeq < terminal.nextInputSeq) break;
            if (request.inputSeq !== terminal.nextInputSeq) throw new Error("Terminal input sequence gap. Reconnect; do not retry unacknowledged input.");
            if (terminal.owner !== "phone") throw new Error("Laptop owns terminal input. Take control before typing.");
            terminal.pty.write(request.data);
            terminal.nextInputSeq++;
            break;
          case "resize":
            if (terminal.owner !== "phone") throw new Error("Take control before resizing the terminal.");
            resize(terminal, request.cols, request.rows);
            break;
          case "close":
            await closeTerminal(terminal);
            await sendPhone(state(requestId, "closed", null, terminal), { force: true });
            return;
        }
        await broadcastState(requestId);
      });
    } catch (error) {
      await sendPhone(state(requestId, "error", error.message), { force: true });
      if (error.code === "TERMINAL_SNAPSHOT_TOO_LARGE" && current?.status === "open") {
        // The preceding open state may already have acknowledged the request. Also
        // publish a generation-scoped error so reconnect cannot wait forever.
        await sendPhone(state(null, "error", error.message), { force: true });
      }
    }
  }

  function disconnectPhone() { phoneSubscribed = false; phoneEpoch++; }

  return {
    initialize, handle, disconnectPhone,
    get supported() { return allowTerminal && runtime !== null && !stopped; },
    get supportError() { return supportError; },
    get terminalId() { return current?.id ?? null; },
    async stop() {
      stopped = true;
      await closeTerminal();
      await queue;
      await closeTerminal();
    },
  };
}
