// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";

// Persistent, append-only diagnostic log for the Weft Device Station (`weft start`). Terminal
// output is ephemeral — when the station process dies (e.g. the "unsettled top-level await" exit
// this file was born to help diagnose) the only record is scrollback. This writes a timestamped,
// rotating log to ~/.weft/station.log so connects, disconnects, every heartbeat, incoming phone
// events, transport reconnects, and crashes survive the process and can be read after the fact.
//
// OPT-IN by design: `appendStationLog(...)` is a no-op until `enableStationLog()` is called. Only
// the standalone `weft start` station turns it on — the in-session `/weft` extension path (which
// already logs to the Copilot session log via session.log) never enables it, so the same
// transport/socket code that calls appendStationLog stays silent there and this file never gets
// written from inside a Copilot session.

const LOG_FILE = "station.log";
const ROTATED_FILE = "station.log.1";
// Rotate at ~1 MB, keeping exactly one backup (station.log.1). A `weft start` station logs a few
// lines a minute (a heartbeat every 120s + occasional phone events), so 1 MB holds a long run
// while capping worst-case disk use at ~2 MB total.
const MAX_BYTES = 1_000_000;

let enabled = false;
let logDir = null;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is best-effort on Windows.
  }
}

/** Absolute path of the active station log (or the default location when not yet enabled). */
export function stationLogPath({ baseDir } = {}) {
  return join(logDir ?? weftHome(baseDir), LOG_FILE);
}

/**
 * Turn on station logging for THIS process and write an opening marker. Called once, early, by
 * the `weft start` station. Safe to call more than once (only the first takes effect).
 */
export function enableStationLog({ baseDir } = {}) {
  if (enabled) return stationLogPath({ baseDir });
  logDir = weftHome(baseDir);
  try {
    ensureDir(logDir);
    enabled = true;
    appendStationLog("station.log_opened", { pid: process.pid, file: stationLogPath() });
  } catch {
    // If we can't even open the log, never let that take the station down — just stay disabled.
    enabled = false;
  }
  return stationLogPath({ baseDir });
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

// Rotate before an append if the current file is at/over the cap: move station.log ->
// station.log.1 (overwriting any previous backup) and start a fresh station.log. Best-effort —
// a rotation failure must never block or crash a log write.
function rotateIfNeeded() {
  try {
    const path = join(logDir, LOG_FILE);
    if (!existsSync(path)) return;
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, join(logDir, ROTATED_FILE));
  } catch {
    // Best-effort rotation.
  }
}

/**
 * Append one line to the station log. No-op unless enableStationLog() has run in this process.
 * Never throws — logging must not be able to crash the station it's diagnosing.
 *
 * @param {string} event   short dotted event name, e.g. "device.connected", "phone.control".
 * @param {object} [detail] key/value pairs rendered as `key=value` on the line.
 * @param {{ level?: "info" | "warn" | "error" }} [opts]
 */
export function appendStationLog(event, detail = {}, { level = "info" } = {}) {
  if (!enabled || !logDir) return;
  try {
    rotateIfNeeded();
    const ts = new Date().toISOString();
    const lvl = String(level).toUpperCase().padEnd(5, " ");
    const tail = formatDetail(detail);
    const line = `${ts} ${lvl} ${event}${tail ? " " + tail : ""}\n`;
    appendFileSync(join(logDir, LOG_FILE), line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort: a failed log write is silently dropped rather than disrupting the station.
  }
}
