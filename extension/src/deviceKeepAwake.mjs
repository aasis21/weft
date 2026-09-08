// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { KEEP_AWAKE_MAX_MS, normalizeKeepAwakeDuration } from "@aasis21/weft-shared";

// The native call and its reset run on the same thread. The child independently enforces
// deadlines and watches stdin EOF, so abrupt station termination cannot strand an inhibitor.
const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
public static class WeftKeepAwake {
  [DllImport("kernel32.dll")]
  static extern uint SetThreadExecutionState(uint flags);
  static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
  static long Deadline(string line) {
    long value;
    if (!long.TryParse(line, out value) || value <= Now()) throw new ArgumentException();
    return Math.Min(value, Now() + 28800000L);
  }
  public static void Run() {
    var input = Task.Run(() => Console.In.ReadLine());
    if (!input.Wait(5000) || input.Result == null) return;
    long deadline = Deadline(input.Result);
    if (SetThreadExecutionState(0x80000001u) == 0) throw new InvalidOperationException();
    try {
      Console.Out.WriteLine("ready");
      Console.Out.Flush();
      input = Task.Run(() => Console.In.ReadLine());
      while (Now() < deadline) {
        if (input.IsCompleted) {
          if (input.Result == null) break;
          deadline = Deadline(input.Result);
          Console.Out.WriteLine("updated");
          Console.Out.Flush();
          input = Task.Run(() => Console.In.ReadLine());
        }
        Thread.Sleep(100);
      }
    } finally {
      SetThreadExecutionState(0x80000000u);
    }
  }
}
'@
[WeftKeepAwake]::Run()
`;

export const validUtilityId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value;

const safeFailure = (error) => error?.code === "timeout" ? "timeout" : "unavailable";
const failure = (code = "unavailable") => Object.assign(new Error(code), { code });

export function createWindowsKeepAwakeHelper({
  expiresAt,
  onFailure = () => {},
  signal,
  spawnFn = spawn,
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let ended = false;
    let intentional = false;
    let ready = false;
    let output = "";
    let waiting = null;
    let timer;

    function finish(code = "unavailable") {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      waiting?.reject(failure(code));
      waiting = null;
      if (!ready) reject(failure(code));
      try { child?.stdin?.end(); } catch { /* already gone */ }
      try { child?.kill(); } catch { /* already gone */ }
      if (ready && !intentional) {
        try { onFailure(code); } catch { /* best-effort notification */ }
      }
    }
    function stop() {
      intentional = true;
      finish();
    }
    function deadline(value) {
      if (!Number.isSafeInteger(value)) throw failure();
      return `${value}\n`;
    }
    const helper = {
      stop,
      updateExpiry(value) {
        if (ended || waiting) return Promise.reject(failure());
        return new Promise((res, rej) => {
          waiting = { resolve: res, reject: rej };
          timer = setTimeout(() => finish("timeout"), timeoutMs);
          try { child.stdin.write(deadline(value)); } catch { finish(); }
        });
      },
    };
    try {
      if (signal?.aborted) return stop();
      signal?.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      child = spawnFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", HELPER_SCRIPT],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );
      child.on("error", () => finish());
      child.on("close", () => finish());
      child.stdin.on("error", () => finish());
      child.stdout.on("error", () => finish());
      child.stdout.on("data", (bytes) => {
        if (ended) return;
        output += Buffer.from(bytes).toString("utf8");
        if (output.length > 64) return finish();
        let newline;
        while ((newline = output.indexOf("\n")) !== -1) {
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (!ready && line === "ready") {
            ready = true;
            clearTimeout(timer);
            resolve(helper);
          } else if (ready && waiting && line === "updated") {
            clearTimeout(timer);
            const current = waiting;
            waiting = null;
            current.resolve();
          } else {
            return finish();
          }
        }
      });
      child.stdin.write(deadline(expiresAt));
    } catch {
      finish();
    }
  });
}

export function createDeviceKeepAwakeController({
  platform = process.platform,
  now = Date.now,
  helperFactory = createWindowsKeepAwakeHelper,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const listeners = new Set();
  const stoppedHelpers = new WeakSet();
  const lifetime = new AbortController();
  let state = { leaseId: null, active: false, expiresAt: null, revision: 0 };
  let current = null;
  let timer = null;
  let closed = false;
  let queue = Promise.resolve();
  let shutdownPromise = null;

  const snapshot = (code = "ok") => ({ ...state, code });
  const enqueue = (fn) => {
    const result = queue.then(fn);
    queue = result.then(() => {}, () => {});
    return result;
  };
  function change(next) {
    if (Object.keys(next).some((key) => next[key] !== state[key])) {
      state = { ...state, ...next, revision: state.revision + 1 };
    }
  }
  function notify(code) {
    for (const listener of listeners) {
      try { listener(snapshot(code)); } catch { /* best-effort status hook */ }
    }
  }
  function clearTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }
  async function stopHelper(helper) {
    if (!helper || stoppedHelpers.has(helper)) return;
    stoppedHelpers.add(helper);
    try { await helper?.stop(); } catch { /* never expose platform errors */ }
  }
  async function release() {
    clearTimer();
    const token = current;
    current = null;
    if (token) {
      token.retired = true;
      await stopHelper(token.helper);
    }
    change({ active: false, expiresAt: null });
  }
  async function expire() {
    if (state.active && now() >= state.expiresAt) {
      await release();
      notify("ok");
    }
  }
  function arm() {
    clearTimer();
    timer = setTimeoutFn(() => { void enqueue(expire); }, Math.max(0, state.expiresAt - now()));
    timer?.unref?.();
  }
  function interrupted(promise) {
    const work = Promise.resolve(promise);
    if (closed) {
      void work.catch(() => {});
      return Promise.reject(failure());
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        lifetime.signal.removeEventListener("abort", abort);
        reject(failure());
      };
      lifetime.signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => {
        lifetime.signal.removeEventListener("abort", abort);
      });
    });
  }
  function helperFailed(token, code) {
    if (token.retired || token.failed) return;
    token.failed = true;
    token.code = code === "timeout" ? "timeout" : "unavailable";
    if (closed) return;
    void enqueue(async () => {
      if (current !== token) return;
      const wasActive = state.active;
      await release();
      if (wasActive) notify(token.code);
    });
  }

  return {
    supported: platform === "win32",
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start({ leaseId, durationMs } = {}) {
      return enqueue(async () => {
        await expire();
        const duration = normalizeKeepAwakeDuration(durationMs);
        if (!validUtilityId(leaseId) || duration === null) return snapshot("invalid-request");
        if (closed) return snapshot("unavailable");
        if (platform !== "win32") return snapshot("unsupported");
        const expiresAt = Math.max(
          state.active && state.leaseId === leaseId ? state.expiresAt : 0,
          now() + Math.min(duration, KEEP_AWAKE_MAX_MS),
        );
        const wasActive = state.active;
        try {
          if (!current) {
            const token = { helper: null, retired: false, failed: false };
            current = token;
            const startup = Promise.resolve().then(() => helperFactory({
              expiresAt,
              signal: lifetime.signal,
              onFailure: (code) => helperFailed(token, code),
            }));
            startup.then((helper) => {
              token.helper = helper;
              if (token.retired || closed) void stopHelper(helper);
            }, () => {});
            await interrupted(startup);
          } else {
            await interrupted(current.helper.updateExpiry(expiresAt));
          }
          if (closed || current?.failed || !current?.helper) throw failure(current?.code);
          change({ leaseId, active: true, expiresAt });
          arm();
          return snapshot();
        } catch (error) {
          const code = current?.code ?? safeFailure(error);
          await release();
          if (wasActive && !closed) notify(code);
          return snapshot(code);
        }
      });
    },
    stop(leaseId) {
      return enqueue(async () => {
        await expire();
        if (!validUtilityId(leaseId)) return snapshot("invalid-request");
        if (closed) return snapshot("unavailable");
        if (platform !== "win32") return snapshot("unsupported");
        if (state.leaseId !== leaseId) return snapshot("lease-mismatch");
        await release();
        return snapshot();
      });
    },
    status() {
      return enqueue(async () => {
        await expire();
        return snapshot(closed ? "unavailable" : platform === "win32" ? "ok" : "unsupported");
      });
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      clearTimer();
      lifetime.abort();
      if (current) {
        current.retired = true;
        // Interrupt a helper even if an injected startup/update has not resolved yet.
        void stopHelper(current.helper);
      }
      listeners.clear();
      shutdownPromise = enqueue(release);
      return shutdownPromise;
    },
  };
}
