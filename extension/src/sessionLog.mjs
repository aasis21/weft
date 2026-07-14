// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";

// Persistent, append-only diagnostic log for a single in-session Weft run (the `/weft` extension
// path that loads inside a spawned Copilot session). It's the per-session twin of stationLog.mjs:
// where `weft start` writes one machine-wide ~/.weft/station.log, each Copilot session writes its
// own ~/.weft/sessions/<sessionId>.log so pairing, phone connect/disconnect, transport switches,
// reconnects, and the session's teardown survive the process and can be read/grepped after the
// session window is gone.
//
// OPT-IN + KEYED: `appendSessionLog(...)` is a no-op until `enableSessionLog({ sessionId })` runs
// once, early, in the session process. The shared transport/socket code (reconnectingSocket.mjs)
// calls BOTH appendStationLog and appendSessionLog for the same events — exactly one is enabled in
// any given process (station vs. session), so each event lands in the right place and the other
// call is a silent no-op. The Copilot session log (session.log) remains the user-facing surface;
// this file is the durable diagnostic record, mirroring how the station separates the two.

const SESSIONS_DIR = "sessions";
// Rotate at ~1 MB, keeping exactly one backup (<sessionId>.log.1) — same policy as the station log.
const MAX_BYTES = 1_000_000;
// Cap how many past session logs accumulate in ~/.weft/sessions: on enable, keep the newest N base
// logs (and their .1 backups) by mtime and best-effort delete the rest, so a machine that spawns
// many short sessions can't grow this directory without bound.
const MAX_SESSION_FILES = 100;

let enabled = false;
let logDir = null;
let logFile = null;
let rotatedFile = null;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is best-effort on Windows.
  }
}

// Session ids are normally UUIDs (filesystem-safe), but never trust that blindly — collapse any
// character outside [A-Za-z0-9._-] to "_" so a stray id can't escape the sessions directory or
// break the filename. An empty/absent id falls back to a pid-based name so a log still exists.
function safeSessionFileStem(sessionId) {
  const raw = String(sessionId ?? "").trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || `session-${process.pid}`;
}

/** Absolute path of the active session log (or null before enableSessionLog has run). */
export function sessionLogPath() {
  return logFile;
}

/**
 * Turn on session logging for THIS process and write an opening marker. Called once, early, by the
 * in-session extension after joinSession yields a sessionId. Safe to call more than once (only the
 * first takes effect).
 */
export function enableSessionLog({ sessionId, baseDir } = {}) {
  if (enabled) return logFile;
  const stem = safeSessionFileStem(sessionId);
  logDir = join(weftHome(baseDir), SESSIONS_DIR);
  logFile = join(logDir, `${stem}.log`);
  rotatedFile = join(logDir, `${stem}.log.1`);
  try {
    ensureDir(logDir);
    pruneOldSessionLogs();
    enabled = true;
    appendSessionLog("session.log_opened", { pid: process.pid, sessionId: stem, file: logFile });
  } catch {
    // If we can't even open the log, never let that take the session down — just stay disabled.
    enabled = false;
  }
  return logFile;
}

// Renders a detail object as space-separated key=value pairs, quoting any value that contains
// whitespace so a line stays greppable and single-line. Nested/undefined values are skipped.
function formatDetail(detail) {
  if (!detail || typeof detail !== "object") return "";
  const parts = [];
  for (const [key, raw] of Object.entries(detail)) {
    if (raw === undefined || raw === null) continue;
    let value = typeof raw === "string" ? raw : JSON.stringify(raw);
    if (/\s|"/.test(value)) value = `"${value.replace(/"/g, "'")}"`;
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

// Rotate before an append if the current file is at/over the cap: move <sessionId>.log ->
// <sessionId>.log.1 (overwriting any previous backup) and start fresh. Best-effort — a rotation
// failure must never block or crash a log write.
function rotateIfNeeded() {
  try {
    if (!existsSync(logFile)) return;
    if (statSync(logFile).size < MAX_BYTES) return;
    renameSync(logFile, rotatedFile);
  } catch {
    // Best-effort rotation.
  }
}

// Best-effort retention: keep the newest MAX_SESSION_FILES base logs (plus their .1 backups) and
// delete older ones so the sessions directory stays bounded across many runs. Never throws.
function pruneOldSessionLogs() {
  try {
    const bases = readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(logDir, name)).mtimeMs;
        } catch {
          // treat unstatable entries as oldest.
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { name } of bases.slice(MAX_SESSION_FILES)) {
      try {
        rmSync(join(logDir, name), { force: true });
        rmSync(join(logDir, `${name}.1`), { force: true });
      } catch {
        // best-effort per-file cleanup.
      }
    }
  } catch {
    // Best-effort pruning — a listing/stat failure must never disrupt logging.
  }
}

/**
 * Append one line to the session log. No-op unless enableSessionLog() has run in this process.
 * Never throws — logging must not be able to crash the session it's diagnosing.
 *
 * @param {string} event   short dotted event name, e.g. "device.connected", "phone.control".
 * @param {object} [detail] key/value pairs rendered as `key=value` on the line.
 * @param {{ level?: "info" | "warn" | "error" }} [opts]
 */
export function appendSessionLog(event, detail = {}, { level = "info" } = {}) {
  if (!enabled || !logFile) return;
  try {
    rotateIfNeeded();
    const ts = new Date().toISOString();
    const lvl = String(level).toUpperCase().padEnd(5, " ");
    const tail = formatDetail(detail);
    const line = `${ts} ${lvl} ${event}${tail ? " " + tail : ""}\n`;
    appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort: a failed log write is silently dropped rather than disrupting the session.
  }
}
