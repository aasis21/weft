// SPDX-License-Identifier: Apache-2.0
import { spawn as childSpawn } from "node:child_process";
import { unlinkSync } from "node:fs";
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

export function spawnCopilotSession({ project, name, mode = "default", identity, spawnFn = childSpawn } = {}) {
  const cwd = project?.path;
  if (!cwd) return { ok: false, error: "Project path is required" };
  const sessionName = name || "weft-session";
  let identityFile;
  try {
    identityFile = writeIdentityFile(identity);
    const copilotArgs = ["-n", sessionName];
    if (mode === "allow-all") copilotArgs.push("--allow-all");
    const env = {
      ...process.env,
      WEFT_IDENTITY_FILE: identityFile,
      WEFT_CHANNEL_ID: identity.channelId,
    };
    const terminal = detectTerminal();
    const launch = buildLaunch({ terminal, cwd, copilotArgs });
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
    if (identityFile) {
      try {
        unlinkSync(identityFile);
      } catch {
        // best-effort cleanup after a failed spawn.
      }
    }
    return { ok: false, error: err?.message ?? String(err) };
  }
}

function buildLaunch({ terminal, cwd, copilotArgs }) {
  if (terminal === "windows-terminal") {
    // `copilot` resolves to copilot.cmd/.ps1 on Windows, not a .exe. wt.exe hands the command
    // straight to CreateProcess (no PATHEXT resolution), so it must be routed through cmd.exe.
    return {
      command: "wt.exe",
      args: ["new-tab", "--startingDirectory", cwd, "cmd.exe", "/k", "copilot", ...copilotArgs],
    };
  }
  if (terminal === "macos-terminal") {
    const script = [
      "on run argv",
      "set workDir to item 1 of argv",
      "set cmdParts to {}",
      "repeat with i from 2 to count of argv",
      "set end of cmdParts to quoted form of (item i of argv)",
      "end repeat",
      "set AppleScript's text item delimiters to space",
      "set cmdText to \"cd \" & quoted form of workDir & \" && \" & (cmdParts as text)",
      "tell application \"Terminal\" to do script cmdText",
      "end run",
    ].join("\n");
    return { command: "osascript", args: ["-e", script, cwd, "copilot", ...copilotArgs] };
  }
  if (terminal === "gnome-terminal") {
    return { command: "gnome-terminal", args: [`--working-directory=${cwd}`, "--", "copilot", ...copilotArgs] };
  }
  return { command: "copilot", args: copilotArgs };
}
