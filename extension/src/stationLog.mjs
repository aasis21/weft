// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";
import { isDiagnosticLoggingEnabled } from "./transportConfig.mjs";

// Persistent, append-only diagnostic log for the Weft Device Station (`weft start`). Terminal
// output is ephemeral — when the station process dies (e.g. the "unsettled top-level await" exit
// this file was born to help diagnose) the only record is scrollback. This writes a timestamped,
// rotating log to ~/.weft/station.log so connects, disconnects, every heartbeat, incoming phone
// events, transport reconnects, and crashes survive the process and can be read after the fact.
//
// Background workers enable this writer; local management operations can explicitly select a
// data home. Shared session transport calls remain silent here until enabled. Every append also
// checks the device preference, so turning diagnostics off needs no worker restart.

const LOG_FILE = "station.log";
const ROTATED_FILE = "station.log.1";
// Rotate at ~1 MB, keeping exactly one backup (station.log.1). A `weft start` station logs a few
// lines a minute (a heartbeat every 120s + occasional phone events), so 1 MB holds a long run
// while capping worst-case disk use at ~2 MB total.
const MAX_BYTES = 1_000_000;

let enabled = false;
let logDir = null;
let failureReported = false;
const DETAIL_KEYS = new Set(["pid", "sessionId", "channel", "role", "version", "stage", "phase",
  "code", "terminal", "operation", "elapsedMs", "durationMs", "count", "n", "attempt", "attempts",
  "delayMs", "kind", "ok", "state", "subtype", "reason", "error", "generation", "bytes"]);
const KNOWN_REASONS = new Set(["pong timeout", "connect timeout", "socket error", "ping failed"]);

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
  return join(baseDir ? weftHome(baseDir) : logDir ?? weftHome(), LOG_FILE);
}

/**
 * Turn on station logging for THIS process and write an opening marker. Called once, early, by
 * the `weft start` station. Safe to call more than once (only the first takes effect).
 */
export function enableStationLog({ baseDir } = {}) {
  if (enabled) return stationLogPath({ baseDir });
  logDir = weftHome(baseDir);
  enabled = true;
  appendStationLog("station.log_opened", { pid: process.pid });
  return stationLogPath({ baseDir });
}

// Renders a detail object as space-separated key=value pairs, quoting any value that contains
// whitespace so a line stays greppable and single-line. Nested/undefined values are skipped.
export function formatDiagnosticDetail(detail) {
  if (!detail || typeof detail !== "object") return "";
  const parts = [];
  for (const [key, raw] of Object.entries(detail)) {
    if (raw === undefined || raw === null) continue;
    if (!DETAIL_KEYS.has(key) || !["string", "number", "boolean"].includes(typeof raw)) continue;
    let value = typeof raw === "string" ? raw : JSON.stringify(raw);
    value = value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
    const knownReason = key === "reason" && KNOWN_REASONS.has(value);
    if (["error", "reason", "subtype", "sessionId", "channel"].includes(key) &&
        !knownReason && !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) continue;
    value = value.replace(/https?:\/\/\S+/gi, "[address]")
      .replace(/\b(?:Bearer|token|secret|password)\s*[:= ]\s*\S+/gi, "[redacted]");
    if (/\s|"/.test(value)) value = `"${value.replace(/"/g, "'")}"`;
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

// Rotate before an append if the current file is at/over the cap: move station.log ->
// station.log.1 (overwriting any previous backup) and start a fresh station.log. A failed rotation
// skips the append and is reported by the writer instead of allowing unlimited growth.
function rotateIfNeeded(dir) {
  const path = join(dir, LOG_FILE);
  if (!existsSync(path)) return;
  if (statSync(path).size < MAX_BYTES) return;
  renameSync(path, join(dir, ROTATED_FILE));
}

/**
 * Append one line when enabled or explicitly scoped to a data home, unless disabled by config.
 * Never throws — logging must not be able to crash the station it's diagnosing.
 *
 * @param {string} event   short dotted event name, e.g. "device.connected", "phone.control".
 * @param {object} [detail] key/value pairs rendered as `key=value` on the line.
 * @param {{ level?: "info" | "warn" | "error" }} [opts]
 */
export function appendStationLog(event, detail = {}, { level = "info", baseDir } = {}) {
  const dir = baseDir ? weftHome(baseDir) : logDir;
  if ((!enabled && !baseDir) || !dir) return;
  try {
    if (!isDiagnosticLoggingEnabled({ baseDir: dir })) return;
    if (!/^[a-zA-Z0-9_.-]{1,96}$/.test(event)) return;
    ensureDir(dir);
    rotateIfNeeded(dir);
    const ts = new Date().toISOString();
    const lvl = String(level).toUpperCase().padEnd(5, " ");
    const tail = formatDiagnosticDetail(detail);
    const line = `${ts} ${lvl} ${event}${tail ? " " + tail : ""}\n`;
    appendFileSync(join(dir, LOG_FILE), line, { encoding: "utf8", mode: 0o600 });
    failureReported = false;
  } catch {
    if (!failureReported) {
      failureReported = true;
      console.error("Weft local diagnostics could not be written. Check the diagnostics setting and access to the Weft data folder.");
    }
  }
}

export function readStationDiagnostics({ baseDir, limit = 100 } = {}) {
  const allowed = new Set(["pid", "role", "version", "stage", "phase", "code", "terminal", "operation", "elapsedMs", "durationMs", "count", "attempt", "attempts", "delayMs", "kind", "ok", "state", "reason"]);
  let lines;
  try { lines = readFileSync(stationLogPath({ baseDir }), "utf8").split(/\r?\n/); }
  catch (error) { if (error.code === "ENOENT") return []; throw new Error("Local diagnostic log could not be read."); }
  const count = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
  return lines.filter(Boolean).slice(-count).flatMap((line) => {
    const match = line.match(/^(\S+)\s+(INFO|WARN|ERROR|DEBUG)\s+([A-Za-z0-9_.-]+)(.*)$/);
    if (!match || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(match[1]) || match[3].length > 96) return [];
    const fields = {};
    for (const item of match[4].matchAll(/([A-Za-z0-9_-]+)=("[^"]*"|\S+)/g)) {
      const value = item[2].replace(/^"|"$/g, "");
      if (allowed.has(item[1]) && (/^[A-Za-z0-9_.:-]{1,120}$/.test(value) ||
          item[1] === "reason" && KNOWN_REASONS.has(value))) fields[item[1]] = value;
    }
    return [{ timestamp: match[1], level: match[2], event: match[3], fields }];
  });
}
