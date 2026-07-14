// SPDX-License-Identifier: Apache-2.0
import { spawn as childSpawn } from "node:child_process";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIdentityFile } from "./handoffIdentity.mjs";

export { writeIdentityFile } from "./handoffIdentity.mjs";

export function detectTerminal(env = process.env, platform = process.platform) {
  if (platform === "win32" && env.WT_SESSION) return "windows-terminal";
  if (platform === "darwin" && env.TERM_PROGRAM) return "macos-terminal";
  if (platform === "linux" && (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE)) {
    return "gnome-terminal";
  }
  return null;
}

export function spawnCopilotSession({ project, name, mode = "default", identity, spawnFn = childSpawn, platform = process.platform } = {}) {
  const cwd = project?.path;
  if (!cwd) return { ok: false, error: "Project path is required" };
  const sessionName = name || "weft-session";
  const cleanup = [];
  try {
    const identityFile = writeIdentityFile(identity);
    cleanup.push(identityFile);
    const copilotArgs = ["-n", sessionName];
    if (mode === "allow-all") copilotArgs.push("--allow-all");
    // The direct-spawn path (no visible terminal) inherits this env correctly. The visible-terminal
    // launchers below can't rely on it — they route through a terminal broker with its own stale
    // environment — so they re-establish these vars inside the new shell via a launcher script.
    const env = {
      ...process.env,
      WEFT_IDENTITY_FILE: identityFile,
      WEFT_CHANNEL_ID: identity.channelId,
    };
    const terminal = detectTerminal(process.env, platform);
    const launch = buildLaunch({ terminal, cwd, copilotArgs, identityFile, channelId: identity.channelId, platform });
    if (launch.launcherFile) cleanup.push(launch.launcherFile);
    const child = spawnFn(launch.command, launch.args, {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child?.unref?.();
    return { ok: true };
  } catch (err) {
    for (const file of cleanup) {
      try {
        unlinkSync(file);
      } catch {
        // best-effort cleanup after a failed spawn.
      }
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// A cmd.exe batch value inside `set "VAR=..."` needs no escaping except a literal double-quote,
// which cmd cannot represent inside a quoted value — strip any (our values are OS paths / random
// channel ids that never legitimately contain one).
function cmdSetValue(value) {
  return String(value).replace(/"/g, "");
}

// Quote a single copilot argument for a cmd.exe batch line. Bare when safe; double-quoted (with
// embedded quotes stripped) when it contains whitespace or cmd metacharacters.
function cmdArg(value) {
  const s = String(value);
  if (s.length && !/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/"/g, "")}"`;
}

// POSIX single-quote: wrap in '...' and escape embedded single quotes as '\''.
function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Writes a throwaway launcher script that re-establishes the WEFT_* identity env *inside the new
// shell* and then execs copilot. This makes the hand-off immune to terminal brokers (Windows
// Terminal, Terminal.app, gnome-terminal-server) that spawn tabs under their own captured
// environment and would otherwise drop env vars we set on the launch process. Leaked into tmp like
// the identity file — the spawned session consumes it at startup and the OS reaps temp later.
function writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs }) {
  const isWindows = platform === "win32";
  const file = join(tmpdir(), `weft-launch-${process.pid}-${randomUUID()}.${isWindows ? "cmd" : "sh"}`);
  let body;
  if (isWindows) {
    body =
      "@echo off\r\n" +
      `set "WEFT_IDENTITY_FILE=${cmdSetValue(identityFile)}"\r\n` +
      `set "WEFT_CHANNEL_ID=${cmdSetValue(channelId)}"\r\n` +
      `cd /d "${cmdSetValue(cwd)}"\r\n` +
      `copilot ${copilotArgs.map(cmdArg).join(" ")}\r\n`;
  } else {
    body =
      "#!/bin/bash\n" +
      `export WEFT_IDENTITY_FILE=${shSingleQuote(identityFile)}\n` +
      `export WEFT_CHANNEL_ID=${shSingleQuote(channelId)}\n` +
      `cd ${shSingleQuote(cwd)}\n` +
      `exec copilot ${copilotArgs.map(shSingleQuote).join(" ")}\n`;
  }
  const fd = openSync(file, "wx", isWindows ? 0o600 : 0o700);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
  return file;
}

function buildLaunch({ terminal, cwd, copilotArgs, identityFile, channelId, platform = process.platform }) {
  if (terminal === "windows-terminal") {
    // The launcher .cmd sets WEFT_* then runs copilot (which resolves to copilot.cmd/.ps1 via cmd's
    // PATHEXT — wt.exe alone can't, it hands the command straight to CreateProcess). Passing the
    // launcher path as a single argv element lets Node/wt quoting handle spaces in the path.
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs });
    return {
      command: "wt.exe",
      args: ["new-tab", "--startingDirectory", cwd, "cmd.exe", "/k", launcherFile],
      launcherFile,
    };
  }
  if (terminal === "macos-terminal") {
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs });
    const script = [
      "on run argv",
      "set launcher to item 1 of argv",
      "tell application \"Terminal\" to do script \"bash \" & quoted form of launcher",
      "end run",
    ].join("\n");
    return { command: "osascript", args: ["-e", script, launcherFile], launcherFile };
  }
  if (terminal === "gnome-terminal") {
    const launcherFile = writeLauncherScript({ platform, identityFile, channelId, cwd, copilotArgs });
    return { command: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", "bash", launcherFile], launcherFile };
  }
  return { command: "copilot", args: copilotArgs };
}
