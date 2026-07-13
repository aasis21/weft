#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import QRCode from "qrcode";
import { createListener } from "../src/listener.mjs";
import { resolveTransportDescriptor } from "../src/transportFactory.mjs";
import { clearTransportConfig, saveTransportConfig, saveSupabaseCredentials, loadSupabaseCredentials, supabaseCredentialsPath, savePairingMode, isPersistentPairingEnabled, loadDeviceName, saveDeviceName } from "../src/transportConfig.mjs";
import { addProject, weftHome, listProjects, removeProject, setDefault } from "../src/projects.mjs";
import { getOrCreatePersistedIdentity, clearPersistedIdentity, rotatePersistedIdentity } from "../src/pairingIdentity.mjs";
import {
  ensureDevTunnelRelay,
  describeStage,
  healthyRegistryEntry,
  forceStopDevTunnel,
  DEVTUNNEL_REGISTRY_FILE,
} from "../src/devtunnel.mjs";
import { readRegistry, isPidAlive } from "../src/registryFile.mjs";
import { enableStationLog, appendStationLog, stationLogPath } from "../src/stationLog.mjs";

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

// Last-resort safety net: `weft start` is a long-running station process — any stray unhandled
// rejection or synchronous throw from deep in the transport/heartbeat stack must never silently
// kill it (that's the "crashed 100s after the heartbeat fired, no stack trace" bug). We keep the
// process alive and print the real stack so the root cause is diagnosable, instead of Node's
// default --unhandled-rejections=throw behavior taking the whole station down.
process.on("unhandledRejection", (reason) => {
  console.error(`\n${c.red("✗ unhandled rejection (station kept running):")}`, reason?.stack ?? reason);
  appendStationLog("process.unhandled_rejection", { error: reason?.stack ?? String(reason) }, { level: "error" });
});
process.on("uncaughtException", (err) => {
  console.error(`\n${c.red("✗ uncaught exception (station kept running):")}`, err?.stack ?? err);
  appendStationLog("process.uncaught_exception", { error: err?.stack ?? String(err) }, { level: "error" });
});

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "start") {
    await start();
  } else if (command === "add-project") {
    const [name, path, ...rest] = args;
    if (!name || !path) throw new Error("Usage: weft add-project <name> <path> [--default]");
    const project = addProject(name, path, { makeDefault: rest.includes("--default") });
    console.log(`Added project ${project.name}: ${project.path}${project.default ? " (default)" : ""}`);
  } else if (command === "remove-project") {
    const [name] = args;
    if (!name) throw new Error("Usage: weft remove-project <name>");
    removeProject(name);
    console.log(`Removed project ${name}`);
  } else if (command === "list-projects") {
    printProjects(listProjects());
  } else if (command === "set-default") {
    const [name] = args;
    if (!name) throw new Error("Usage: weft set-default <name>");
    setDefault(name);
    console.log(`Default project set to ${name}`);
  } else if (command === "set-transport") {
    setTransport(args);
  } else if (command === "show-transport") {
    showTransport();
  } else if (command === "set-name") {
    setName(args);
  } else if (command === "show-name") {
    showName();
  } else if (command === "set-pairing") {
    await setPairing(args);
  } else if (command === "rotate-pairing") {
    await rotatePairing();
  } else if (command === "devtunnel") {
    await devtunnelCommand(args);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exitCode = 1;
}

async function setPairing([mode]) {
  if (mode !== "persistent" && mode !== "ephemeral") {
    throw new Error("Usage: weft set-pairing <persistent|ephemeral>");
  }
  savePairingMode(mode);
  if (mode === "persistent") {
    // Mint (or reuse) the persisted identity right away so `weft show-pairing`/`weft start`
    // has something concrete to report immediately, rather than waiting for the next start.
    await getOrCreatePersistedIdentity();
    console.log("Pairing set to persistent: the same channel + key are reused across every 'weft start' and /weft session.");
    console.log("An already-paired phone will reconnect without rescanning. Run 'weft rotate-pairing' to force a fresh code.");
  } else {
    clearPersistedIdentity();
    console.log("Pairing set to ephemeral: a fresh channel + key are minted every run (forward-secret default).");
  }
}

async function rotatePairing() {
  await rotatePersistedIdentity();
  console.log("Persisted pairing identity rotated — the next 'weft start' or /weft will show a new QR to (re)scan.");
}

// Standalone entry point for the shared devtunnel relay — usable independently of any paired
// phone or `/weft` session, for first-time setup or troubleshooting. Shares provisioning/
// discovery logic with the extension (src/devtunnel.mjs) so behavior is identical either way.
async function devtunnelCommand([sub, ...rest]) {
  if (sub === "start") return devtunnelStart();
  if (sub === "status") return devtunnelStatus();
  if (sub === "stop") return devtunnelStop();
  throw new Error("Usage: weft devtunnel <start|status|stop>");
}

async function devtunnelStart() {
  printHeader("WEFT DEVTUNNEL");

  // Provision-and-own vs attach-and-watch: ensureDevTunnelRelay returns `child: null` iff a
  // healthy relay was already running on this machine — this terminal then just watches, and
  // Ctrl+C exits the watcher without touching the relay. Otherwise `child` is the ChildProcess
  // this terminal spawned, whose lifetime is now tied to it (Ctrl+C or terminal close → tear it
  // all down, including the cloud tunnel).
  const status = createProvisionStatusLine();
  const existing = await healthyRegistryEntry();
  let child = null;
  let baseUrl;

  if (existing) {
    baseUrl = existing.baseUrl;
    console.log(`${c.green("✓")} ${c.bold("devtunnel already running")}  ${c.dim(baseUrl)}`);
    console.log(c.dim(`pid ${existing.pid} · owned by another terminal — this one is just watching.`));
    console.log(c.dim("Ctrl+C exits the watcher; the relay keeps running until its owning terminal closes."));
    await watchExistingRelay(existing.pid);
    return;
  }

  status.start();
  try {
    const result = await ensureDevTunnelRelay({
      onProgress: (stage) => status.setStage(stage),
      onRetry: (attempt, maxAttempts) => status.setRetry(attempt, maxAttempts),
    });
    status.stop();
    baseUrl = result.baseUrl;
    child = result.child;
  } catch (err) {
    status.stop();
    console.error(`${c.red("✗")} ${err?.message ?? err}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${c.green("✓")} ${c.bold("devtunnel ready")}  ${c.dim(baseUrl)}`);
  console.log(c.dim("This terminal owns the relay. Keep it open — every `weft start` and `/weft`"));
  console.log(c.dim("on this machine will use this tunnel. Ctrl+C stops the relay and deletes the cloud tunnel."));
  await ownAndBlock(child);
}

// The owning terminal blocks on child.exit; a Ctrl+C (or SIGTERM) triggers forceStopDevTunnel
// rather than a bare child.kill() because on Windows a forwarded signal is an immediate hard-kill
// that bypasses the child's own cleanup handler — forceStopDevTunnel does the cleanup itself
// (taskkill, delete cloud tunnel, clear registry), which is cross-platform correct.
async function ownAndBlock(child) {
  let shuttingDown = false;
  const stop = async (label) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(c.dim(`\nStopping relay (${label})…`));
    try {
      await forceStopDevTunnel();
    } catch (err) {
      console.error(c.red(`teardown failed: ${err?.message ?? err}`));
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await new Promise((resolve) => child.once("exit", () => resolve()));
  console.log(`${c.green("✓")} ${c.bold("relay stopped")} ${c.dim("· cloud tunnel released.")}`);
}

// The watching terminal polls the owning pid every second; when it disappears (owner closed
// their terminal, or ran `weft devtunnel stop`), we exit the watcher cleanly. Ctrl+C in this
// terminal exits the watcher without disturbing the relay — this is the "attach" path.
async function watchExistingRelay(pid) {
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (!isPidAlive(pid)) {
        clearInterval(interval);
        console.log(`\n${c.yellow("○")} ${c.bold("relay stopped")} ${c.dim(`(pid ${pid} exited).`)}`);
        resolve();
      }
    }, 1000);
    interval.unref?.();
    process.once("SIGINT", () => {
      clearInterval(interval);
      console.log(c.dim("\nExiting watcher — relay keeps running (owned by another terminal)."));
      resolve();
    });
  });
}

async function devtunnelStatus() {
  const registryEntry = readRegistry(DEVTUNNEL_REGISTRY_FILE);
  if (!registryEntry) {
    console.log(`${c.yellow("○")} Not running. Run ${c.bold("weft devtunnel start")} to provision it.`);
    return;
  }
  if (!isPidAlive(registryEntry.pid)) {
    console.log(`${c.yellow("○")} Stale entry (pid ${registryEntry.pid} no longer running). Run ${c.bold("weft devtunnel start")} to reprovision.`);
    return;
  }
  const healthy = await healthyRegistryEntry();
  if (!healthy) {
    console.log(`${c.yellow("!")} Registered (pid ${registryEntry.pid}) but not accepting connections on port ${registryEntry.relayPort}.`);
    console.log(c.dim(`Run ${c.bold("weft devtunnel stop")} then ${c.bold("weft devtunnel start")} to reset it.`));
    return;
  }
  const upForMs = Date.now() - (registryEntry.startedAt ?? Date.now());
  console.log(`${c.green("●")} ${c.bold("running")}  ${c.dim(healthy.baseUrl)}`);
  console.log(c.dim(`   pid ${registryEntry.pid} · up ${Math.round(upForMs / 1000)}s · tunnel ${registryEntry.tunnelId ?? "?"}`));
}

async function devtunnelStop() {
  const { stopped, entry } = await forceStopDevTunnel();
  if (!stopped) {
    console.log(c.dim("Nothing was running."));
    return;
  }
  console.log(`${c.green("✓")} Stopped the shared devtunnel relay${entry?.pid ? ` (was pid ${entry.pid})` : ""}.`);
}

// Live status line for `weft devtunnel start`, shown while ensureDevTunnelRelay works
// through its stages. Mirrors createStatusLine's spinner/redraw approach below, but renders
// provisioning stage + retry-attempt text instead of device-connection state.
function createProvisionStatusLine() {
  const tty = Boolean(process.stdout.isTTY);
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let label = "starting…";

  function render() {
    if (!tty) return;
    const spin = c.yellow(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
    process.stdout.write(`\r\x1b[2K${spin} ${c.dim(label)}`);
  }

  return {
    start() {
      if (!tty) {
        console.log("Setting up a devtunnel — this can take a couple of minutes on first run…");
        return;
      }
      spinnerTimer = setInterval(() => {
        spinnerFrame += 1;
        render();
      }, 120);
      spinnerTimer.unref?.();
      render();
    },
    setStage(stage) {
      label = describeStage(stage);
      if (!tty) console.log(label);
      else render();
    },
    setRetry(attempt, maxAttempts) {
      label = `still setting up (attempt ${attempt + 1}/${maxAttempts})…`;
      if (!tty) console.log(label);
      else render();
    },
    stop() {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      if (tty) process.stdout.write("\r\x1b[2K");
    },
  };
}

async function start() {
  const lock = acquireLock();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lock.release();
  };

  // Turn on the persistent station log for this process (see stationLog.mjs). Only the standalone
  // `weft start` station does this — the in-session /weft path logs to the Copilot session log
  // instead — so the shared transport/socket code that calls appendStationLog stays silent there.
  enableStationLog();
  appendStationLog("station.start", { pid: process.pid, device: loadDeviceName() ?? hostname() });

  const status = createStatusLine();
  const listener = createListener({
    onDeviceConnected: (peer) => {
      status.setConnected(true);
      appendStationLog("device.connected", { phone: peer?.senderName ?? peer?.deviceId ?? "unknown" });
    },
    onDeviceDisconnected: () => {
      status.setConnected(false);
      appendStationLog("device.disconnected", {}, { level: "warn" });
    },
    onHeartbeat: () => {
      status.pulse();
      appendStationLog("heartbeat", {});
    },
    // Persistent mode + a known-returning phone: the listener is ALREADY sending heartbeats to
    // the last-known channel before this run's phone has said anything — show that as
    // "connected" right away instead of a "waiting/reconnecting" spinner, since we're genuinely
    // not waiting on the phone for anything at this point.
    onOptimisticBind: () => {
      status.setConnected(true);
      appendStationLog("device.optimistic_bind", {});
    },
    onControl: ({ subtype }) => appendStationLog("phone.control", { subtype: subtype ?? "unknown" }),
    onSpawnRequest: ({ projectName, mode, name }) => {
      status.log(`${c.cyan("→")} Session request: ${c.bold(name || "(unnamed)")} on ${projectName || "default project"} ${c.dim(`[${mode}]`)}`);
      appendStationLog("spawn.request", { name: name || "(unnamed)", project: projectName || "default", mode });
    },
    onSpawnResult: ({ ok, error, name, projectName }) => {
      status.log(
        ok
          ? `${c.green("✓")} Session started: ${c.bold(name)} ${c.dim(`(${projectName})`)}`
          : `${c.red("✗")} Session failed${projectName ? ` (${projectName})` : ""}: ${error}`,
      );
      appendStationLog("spawn.result", { ok, name, project: projectName, error }, { level: ok ? "info" : "warn" });
    },
  });

  printHeader(`WEFT DEVICE STATION — ${loadDeviceName() ?? hostname()}`);
  console.log(c.dim("Keep this window open to let your phone connect and drive Copilot sessions."));
  console.log(c.dim(`Diagnostic log: ${stationLogPath()}\n`));

  await ensureAtLeastOneProject();

  await listener.start();
  appendStationLog("station.ready", {
    channelId: listener.channelId,
    device: listener.deviceName,
    pairing: isPersistentPairingEnabled() ? "persistent" : "ephemeral",
    heartbeatMs: listener.heartbeatMs,
  });

  console.log(`${c.bold("1.")} Scan the QR code below with the Weft app to pair your phone:\n`);
  const qr = (await QRCode.toString(JSON.stringify(listener.pairingPayload), { type: "terminal", small: true })).replace(/\n+$/, "");
  console.log(qr);
  console.log();
  console.log(`${c.bold("2.")} These identify this station for the pairing/session comms:\n`);
  console.log(`   ${c.cyan("Device ID")}   ${c.bold(listener.deviceId)}`);
  console.log(`   ${c.cyan("Channel ID")}  ${c.bold(listener.channelId)}`);
  const persistent = isPersistentPairingEnabled();
  const everConnected = listener.everConnectedBeforeThisRun === true;
  const optimisticallyBound = listener.optimisticallyBound === true;
  console.log(
    `   ${c.cyan("Pairing")}     ${persistent ? c.green("persistent") : c.yellow("ephemeral")}` +
      c.dim(
        persistent
          ? everConnected
            ? " — same channel/key as before; this phone should reconnect automatically, no rescan needed."
            : " — same channel/key will be reused every start once a phone first scans it below."
          : " — a fresh channel/key every start; re-scan the QR each time (run `weft set-pairing persistent` to change).",
      ),
  );
  console.log(`   ${c.dim(`Heartbeat every ${Math.round(listener.heartbeatMs / 1000)}s keeps the pairing alive.`)}\n`);
  console.log(`${c.bold("3.")} Projects available to spawn sessions in:\n`);
  printProjects(listProjects());
  console.log(c.dim("   Hint: add projects with `weft add-project <name> <path> --default`.\n"));
  // optimisticallyBound: the listener is ALREADY sending heartbeats to this phone's remembered
  // channel — we aren't actually waiting on anything from it, so say so plainly instead of
  // "reconnecting"/"waiting" wording that implies we're blocked. The live status line below
  // (driven by onOptimisticBind → status.setConnected(true)) already reflects this as
  // "device connected · last heartbeat Ns ago".
  const idleLabel = optimisticallyBound
    ? "heartbeat active on the last-known channel…"
    : persistent && everConnected
      ? "reconnecting a previously-paired phone…"
      : "waiting for phone to connect…";
  console.log(
    `${c.bold("4.")} ${
      optimisticallyBound
        ? "Already sending heartbeats on the last-known channel — your phone attaches silently, no waiting"
        : persistent && everConnected
          ? "Reconnecting — this phone paired here before, so it should attach automatically"
          : "Waiting for your phone to connect"
    }…\n`,
  );
  status.setIdleLabel(idleLabel);
  status.start();

  const shutdown = async (signal) => {
    appendStationLog("station.stop", { signal: signal ?? "exit" });
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
function createStatusLine({ idleLabel = "listening for phone…" } = {}) {
  const tty = Boolean(process.stdout.isTTY);
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let connected = false;
  let spinnerFrame = 0;
  let spinnerTimer = null;
  let tickTimer = null;
  let pulseTimer = null;
  let bright = false;
  let lastBeatAt = null;
  let label = idleLabel;

  function render() {
    if (!tty) return;
    let line;
    if (!connected) {
      // Spinner proves the station process itself is alive/listening even before any phone has
      // ever paired (the DEVICE_HEARTBEAT protocol only starts once a phone is bound).
      const spin = c.yellow(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
      line = `${spin} ${c.dim(label)}`;
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
        // onOptimisticBind may already have fired `setConnected(true)` during listener.start()
        // (before this call) and logged "Device connected." — don't also print the stale idle
        // line on top of that.
        if (!connected) console.log(`${label.charAt(0).toUpperCase()}${label.slice(1).replace(/…$/, "")}…`);
        return;
      }
      // onOptimisticBind (persistent mode, known-returning phone) may have already called
      // setConnected(true) during listener.start(), before this runs — pick up ticking rather
      // than clobbering it with the idle spinner.
      if (connected) {
        startTicking();
      } else {
        startSpinner();
      }
      render();
    },
    setIdleLabel(next) {
      label = next;
      if (!connected) render();
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

async function ensureAtLeastOneProject() {
  if (listProjects().length > 0) return;
  if (!process.stdin.isTTY) {
    console.log(c.dim("   No projects registered — run `weft add-project <name> <path> --default` to add one.\n"));
    return;
  }
  console.log(c.yellow("No projects are registered yet — your phone won't be able to start sessions until one is added.\n"));
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question(`   Folder to register as a project [${process.cwd()}]: `)).trim();
      const path = answer || process.cwd();
      const name = basename(resolve(path));
      try {
        const project = addProject(name, path, { makeDefault: true });
        console.log(c.green(`   Added project ${project.name}: ${project.path} (default)\n`));
        return;
      } catch (err) {
        console.log(c.red(`   ${err?.message ?? err}`));
      }
    }
  } finally {
    rl.close();
  }
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
  // "local" is a harness/test-only kind, never offered by this CLI's own set-transport command
  // — still describe it plainly if somehow configured directly (e.g. by a test).
  if (descriptor.kind === "local") return "local (same-machine, no relay)";
  return descriptor.kind;
}

// Only "supabase" and "devtunnel" are offered here — Weft's two supported, documented transports.
// "local" remains fully implemented (transportConfig.mjs, transportFactory.mjs) for the harness/
// tests only (saveTransportConfig called directly, not through this CLI), just not surfaced by
// this command's usage text or accepted kinds. The transport CHOICE is persisted to the single
// ~/.weft/weft.config.json file; Supabase creds live separately in ~/.weft/supabase.json so
// flipping between kinds never destroys stored connection details.
function setTransport(args) {
  const [kind, ...rest] = args;
  const flags = parseFlags(rest);
  if (kind === "supabase") {
    const url = flags.url;
    const anonKey = flags["anon-key"];
    const provided = (url ? 1 : 0) + (anonKey ? 1 : 0);
    if (provided === 1) {
      throw new Error("Usage: --url and --anon-key must be provided together (or omit both to reuse the credentials already at ~/.weft/supabase.json).");
    }
    if (provided === 2) {
      // Explicit override: overwrite supabase.json with the caller's values. Both go through
      // saveSupabaseCredentials's own trim + non-empty validation, so a `--url " "` fails loudly
      // rather than silently poisoning the creds file.
      saveSupabaseCredentials({ url, anonKey });
    } else if (!loadSupabaseCredentials()) {
      // No flags AND no existing creds file — nothing to point the pointer at. Refuse rather
      // than write a dangling pointer that would just make `/weft` throw at pairing time.
      throw new Error(
        `Weft: no supabase credentials found at ${supabaseCredentialsPath()}. ` +
          "Provide them with `weft set-transport supabase --url <url> --anon-key <key>`, or " +
          "re-run the installer to seed the hosted defaults.",
      );
    }
    saveTransportConfig({ kind: "supabase" });
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
    console.log("Cleared the configured transport. Run `weft set-transport` again to choose one before pairing.");
    console.log(c.dim(`(Stored supabase credentials at ${supabaseCredentialsPath()} were left in place — delete that file manually to forget them.)`));
    return;
  } else {
    throw new Error("Usage: weft set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]");
  }
  console.log(`Transport set to ${kind}. This is stamped into every pairing QR, so re-pair your phone to pick it up.`);
}

function showTransport() {
  let descriptor;
  try {
    descriptor = resolveTransportDescriptor();
  } catch (err) {
    console.log(err?.message ?? String(err));
    return;
  }
  console.log(`Current transport: ${describeTransport(descriptor)}`);
  console.log(c.dim(`Source: ${join(weftHome(), "weft.config.json")}`));
  if (descriptor.kind === "supabase") {
    console.log(c.dim(`Credentials: ${supabaseCredentialsPath()}`));
  }
}

// The display name shown to phones (DEVICES list entry, senderName on every message this
// listener/CLI sends). Defaults to os.hostname() until the user picks their own via `weft
// set-name` (offered interactively at install time, defaulting to the machine hostname).
function setName([...nameParts]) {
  const name = nameParts.join(" ").trim();
  if (!name) throw new Error("Usage: weft set-name <name>");
  const saved = saveDeviceName(name);
  console.log(`Device name set to "${saved}". Restart \`weft start\` / /weft for phones to see the new name.`);
}

function showName() {
  const configured = loadDeviceName();
  if (configured) {
    console.log(`Current device name: ${configured} ${c.dim("(from weft set-name)")}`);
  } else {
    console.log(`Current device name: ${hostname()} ${c.dim("(OS hostname — no custom name set, run `weft set-name <name>` to change)")}`);
  }
}

function usage() {
  console.log(`Usage:
  weft start
  weft add-project <name> <path> [--default]
  weft remove-project <name>
  weft list-projects
  weft set-default <name>
  weft set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]
  weft show-transport
  weft set-name <name>
  weft show-name
  weft set-pairing <persistent|ephemeral>
  weft rotate-pairing
  weft devtunnel <start|status|stop>
  weft help

Your transport CHOICE lives in ~/.weft/weft.config.json (written by \`weft set-transport\`).
Supabase's connection details (url + anon key) live separately in ~/.weft/supabase.json — the
installer seeds it once with the hosted defaults, and \`weft set-transport supabase --url X
--anon-key Y\` overwrites it. There is no .env / WEFT_TRANSPORT env var — reinstalling or
rebuilding the extension never touches either file, so your chosen transport always survives.

Your device's display name (shown to phones in the DEVICES list) defaults to your OS hostname
until you set your own with \`weft set-name <name>\` — the installer offers this as an
interactive prompt (default: your hostname) the first time you install.

By default every \`weft start\` / /weft mints a brand-new channel + key (forward-secret, but
means rescanning the QR every time). Run \`weft set-pairing persistent\` to reuse the same
channel + key across every run instead — an already-paired phone then reconnects with no
rescan. \`weft rotate-pairing\` forces a fresh one on demand; \`weft set-pairing ephemeral\`
reverts to a new identity every run.

\`weft devtunnel start\` provisions (or attaches to) the shared devtunnel relay in the
foreground with a live status line — useful for first-time setup or watching a slow
provision independently of any \`/weft\` session. \`weft devtunnel status\` reports whether
it's currently running; \`weft devtunnel stop\` force-tears it down for troubleshooting.`);
}

