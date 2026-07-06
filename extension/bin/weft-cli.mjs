#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import QRCode from "qrcode";
import { createListener } from "../src/listener.mjs";
import { loadLocalEnv, resolveTransportDescriptor } from "../src/transportFactory.mjs";
import { clearTransportConfig, saveTransportConfig } from "../src/transportConfig.mjs";
import { addProject, weftHome, listProjects, removeProject, setDefault } from "../src/projects.mjs";

const [, , command, ...args] = process.argv;

const supportsColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const wrap = (open, close) => (text) => (supportsColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  cyan: wrap(36, 39),
  green: wrap(32, 39),
  brightGreen: wrap(92, 39),
  yellow: wrap(33, 39),
  red: wrap(31, 39),
};

function printHeader(title) {
  const width = title.length + 4;
  const bar = "─".repeat(width);
  console.log(c.cyan(`┌${bar}┐`));
  console.log(`${c.cyan("│")}  ${c.bold(title)}  ${c.cyan("│")}`);
  console.log(c.cyan(`└${bar}┘`));
}

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "start") {
    await start();
  } else if (command === "add-project") {
    const [name, path, ...rest] = args;
    if (!name || !path) throw new Error("Usage: weft-cli add-project <name> <path> [--default]");
    const project = addProject(name, path, { makeDefault: rest.includes("--default") });
    console.log(`Added project ${project.name}: ${project.path}${project.default ? " (default)" : ""}`);
  } else if (command === "remove-project") {
    const [name] = args;
    if (!name) throw new Error("Usage: weft-cli remove-project <name>");
    removeProject(name);
    console.log(`Removed project ${name}`);
  } else if (command === "list-projects") {
    printProjects(listProjects());
  } else if (command === "set-default") {
    const [name] = args;
    if (!name) throw new Error("Usage: weft-cli set-default <name>");
    setDefault(name);
    console.log(`Default project set to ${name}`);
  } else if (command === "set-transport") {
    setTransport(args);
  } else if (command === "show-transport") {
    showTransport();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exitCode = 1;
}

async function start() {
  loadLocalEnv();
  const lock = acquireLock();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lock.release();
  };

  const status = createStatusLine();
  const listener = createListener({
    onDeviceConnected: () => status.setConnected(true),
    onDeviceDisconnected: () => status.setConnected(false),
    onHeartbeat: () => status.pulse(),
    onSpawnRequest: ({ projectName, mode, name }) =>
      status.log(`${c.cyan("→")} Session request: ${c.bold(name || "(unnamed)")} on ${projectName || "default project"} ${c.dim(`[${mode}]`)}`),
    onSpawnResult: ({ ok, error, name, projectName }) =>
      status.log(
        ok
          ? `${c.green("✓")} Session started: ${c.bold(name)} ${c.dim(`(${projectName})`)}`
          : `${c.red("✗")} Session failed${projectName ? ` (${projectName})` : ""}: ${error}`,
      ),
  });

  printHeader(`WEFT DEVICE STATION — ${hostname()}`);
  console.log(c.dim("Keep this window open to let your phone connect and drive Copilot sessions.\n"));

  await listener.start();

  console.log(`${c.bold("1.")} Scan the QR code below with the Weft app to pair your phone:\n`);
  const qr = (await QRCode.toString(JSON.stringify(listener.pairingPayload), { type: "terminal", small: true })).replace(/\n+$/, "");
  console.log(qr);
  console.log();
  console.log(`${c.bold("2.")} These identify this station for the pairing/session comms:\n`);
  console.log(`   ${c.cyan("Device ID")}   ${c.bold(listener.deviceId)}`);
  console.log(`   ${c.cyan("Channel ID")}  ${c.bold(listener.channelId)}`);
  console.log(`   ${c.dim(`Heartbeat every ${Math.round(listener.heartbeatMs / 1000)}s keeps the pairing alive.`)}\n`);
  console.log(`${c.bold("3.")} Projects available to spawn sessions in:\n`);
  printProjects(listProjects());
  console.log(c.dim("   Hint: add projects with `weft-cli add-project <name> <path> --default`.\n"));
  console.log(`${c.bold("4.")} Waiting for your phone to connect…\n`);
  status.start();

  const shutdown = async (signal) => {
    status.stop();
    await listener.stop();
    release();
    if (signal) process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("exit", release);
  await new Promise(() => {});
}

function acquireLock() {
  const dir = weftHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on Windows.
  }
  const file = join(dir, "listener.lock");
  let existing = null;
  try {
    existing = Number.parseInt(readFileSync(file, "utf8"), 10);
  } catch {
    // no lock
  }
  if (existing && isProcessAlive(existing)) {
    throw new Error(`A Weft Device Station is already running (pid ${existing}).`);
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on Windows.
  }
  return {
    release() {
      try {
        if (Number.parseInt(readFileSync(file, "utf8"), 10) === process.pid) unlinkSync(file);
      } catch {
        // best-effort
      }
    },
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Renders a single, in-place status line under the QR/banner output so the terminal shows the
// Device Station's live connection + heartbeat state without growing the scrollback. Falls back to
// one plain, non-blinking log line when stdout isn't a TTY (e.g. piped to a file or `nohup`), since
// carriage-return redraws only make sense on an interactive terminal.
function createStatusLine() {
  const tty = Boolean(process.stdout.isTTY);
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let connected = false;
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let tickTimer = null;
  let pulseTimer = null;
  let bright = false;
  let lastBeatAt = null;

  function render() {
    if (!tty) return;
    let line;
    if (!connected) {
      // Spinner proves the station process itself is alive/listening even before any phone has
      // ever paired (the DEVICE_HEARTBEAT protocol only starts once a phone is bound).
      const spin = c.yellow(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
      line = `${spin} ${c.dim("listening for phone…")}`;
    } else {
      const dot = bright ? c.brightGreen("●") : c.green("●");
      const agoMs = lastBeatAt ? Date.now() - lastBeatAt : null;
      const ago = agoMs === null ? "warming up…" : `last heartbeat ${Math.max(0, Math.round(agoMs / 1000))}s ago`;
      line = `${dot} ${c.bold("device connected")} ${c.dim(`· ${ago}`)}`;
    }
    process.stdout.write(`\r\x1b[2K${line}`);
  }

  function startSpinner() {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      spinnerFrame += 1;
      render();
    }, 120);
    spinnerTimer.unref?.();
  }

  function stopSpinner() {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(render, 1000);
    tickTimer.unref?.();
  }

  function stopTicking() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  return {
    start() {
      if (!tty) {
        console.log("Waiting for phone to connect…");
        return;
      }
      startSpinner();
      render();
    },
    setConnected(value) {
      connected = value;
      if (value) {
        lastBeatAt = Date.now();
        stopSpinner();
        startTicking();
      } else {
        lastBeatAt = null;
        stopTicking();
        startSpinner();
      }
      if (!tty) {
        console.log(value ? "Device connected." : "Device disconnected; waiting for phone…");
        return;
      }
      render();
    },
    // Print a one-off line (session request/result) above the live status line, then redraw it,
    // so events scroll normally while the connection/heartbeat indicator stays pinned at the bottom.
    log(line) {
      if (!tty) {
        console.log(line);
        return;
      }
      process.stdout.write(`\r\x1b[2K${line}\n`);
      render();
    },
    // Flash the dot brighter on every outgoing DEVICE_HEARTBEAT and reset the "Ns ago" ticker, so a
    // real beat is visible even though the interval (15s) is too long to rely on a single flash.
    pulse() {
      lastBeatAt = Date.now();
      if (!tty) return;
      bright = true;
      render();
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        bright = false;
        render();
      }, 350);
      pulseTimer.unref?.();
    },
    stop() {
      stopSpinner();
      stopTicking();
      clearTimeout(pulseTimer);
      if (tty) process.stdout.write("\r\x1b[2K");
    },
  };
}

function printProjects(projects) {
  if (!projects.length) {
    console.log(c.dim("   No projects registered."));
    return;
  }
  for (const p of projects) {
    const tag = p.default ? c.cyan(" (default)") : "";
    console.log(`   ${c.bold(p.name)}${tag}  ${c.dim(resolve(p.path))}`);
  }
}

/** Parses `--flag value` pairs out of a CLI args array (case-insensitive flag names). */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    flags[arg.slice(2).toLowerCase()] = args[i + 1];
    i += 1;
  }
  return flags;
}

function describeTransport(descriptor) {
  if (descriptor.kind === "supabase") return `supabase (${descriptor.url})`;
  if (descriptor.kind === "devtunnel") return "devtunnel (shared local relay via Microsoft Dev Tunnels — no cloud account)";
  // "local"/"webpubsub" are internal/testing-only kinds, kept working but never offered by this
  // CLI's own set-transport command — still describe them plainly if somehow configured directly.
  if (descriptor.kind === "local") return "local (same-machine, no relay)";
  if (descriptor.kind === "webpubsub") return `webpubsub (${descriptor.negotiateUrl})`;
  return descriptor.kind;
}

// Only "supabase" and "devtunnel" are offered here — Weft's two supported, documented transports.
// "local"/"webpubsub" remain fully implemented (transportConfig.mjs, transportFactory.mjs) for
// internal testing / advanced WEFT_TRANSPORT env overrides, just no longer surfaced by this
// command's usage text or accepted kinds, so users are never offered an option Weft doesn't
// actually support end-to-end.
function setTransport(args) {
  const [kind, ...rest] = args;
  const flags = parseFlags(rest);
  if (kind === "supabase") {
    const url = flags.url;
    const anonKey = flags["anon-key"];
    if (!url || !anonKey) {
      throw new Error("Usage: weft-cli set-transport supabase --url <url> --anon-key <key>");
    }
    saveTransportConfig({ kind: "supabase", url, anonKey });
  } else if (kind === "devtunnel") {
    saveTransportConfig({ kind: "devtunnel" });
    console.log(
      c.dim(
        "Note: requires the `devtunnel` CLI installed and logged in (`devtunnel user login -g`). " +
          "The shared relay/tunnel is provisioned lazily on first pair, not right now.",
      ),
    );
  } else if (kind === "clear") {
    clearTransportConfig();
    console.log("Cleared the configured transport; falling back to env vars / the default (supabase).");
    return;
  } else {
    throw new Error("Usage: weft-cli set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]");
  }
  console.log(`Transport set to ${kind}. This is stamped into every pairing QR, so re-pair your phone to pick it up.`);
}

function showTransport() {
  loadLocalEnv();
  const descriptor = resolveTransportDescriptor();
  const source = process.env.WEFT_TRANSPORT
    ? "WEFT_TRANSPORT env var"
    : "weft-cli set-transport (or the built-in default)";
  console.log(`Current transport: ${describeTransport(descriptor)}`);
  console.log(c.dim(`Source: ${source}`));
}

function usage() {
  console.log(`Usage:
  weft-cli start
  weft-cli add-project <name> <path> [--default]
  weft-cli remove-project <name>
  weft-cli list-projects
  weft-cli set-default <name>
  weft-cli set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]
  weft-cli show-transport
  weft-cli help`);
}
