#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import QRCode from "qrcode";
import { createListener } from "../src/listener.mjs";
import { loadLocalEnv } from "../src/transportFactory.mjs";
import { addProject, helmHome, listProjects, removeProject, setDefault } from "../src/projects.mjs";

const [, , command, ...args] = process.argv;

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "start") {
    await start();
  } else if (command === "add-project") {
    const [name, path, ...rest] = args;
    if (!name || !path) throw new Error("Usage: helm-cli add-project <name> <path> [--default]");
    const project = addProject(name, path, { makeDefault: rest.includes("--default") });
    console.log(`Added project ${project.name}: ${project.path}${project.default ? " (default)" : ""}`);
  } else if (command === "remove-project") {
    const [name] = args;
    if (!name) throw new Error("Usage: helm-cli remove-project <name>");
    removeProject(name);
    console.log(`Removed project ${name}`);
  } else if (command === "list-projects") {
    printProjects(listProjects());
  } else if (command === "set-default") {
    const [name] = args;
    if (!name) throw new Error("Usage: helm-cli set-default <name>");
    setDefault(name);
    console.log(`Default project set to ${name}`);
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

  const listener = createListener();
  await listener.start();
  const qr = (await QRCode.toString(JSON.stringify(listener.pairingPayload), { type: "terminal", small: true })).replace(/\n+$/, "");
  console.log(qr);
  console.log(`\nHelm listener ready on ${listener.channelId}. Scan this listener QR from your phone.`);
  printProjects(listProjects());
  console.log("Hint: add projects with `helm-cli add-project <name> <path> --default`.");

  const shutdown = async (signal) => {
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
  const dir = helmHome();
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
    throw new Error(`A Helm listener is already running (pid ${existing}).`);
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

function printProjects(projects) {
  if (!projects.length) {
    console.log("No projects registered.");
    return;
  }
  console.log("Registered projects:");
  for (const p of projects) {
    console.log(`- ${p.name}${p.default ? " (default)" : ""}: ${resolve(p.path)}`);
  }
}

function usage() {
  console.log(`Usage:
  helm-cli start
  helm-cli add-project <name> <path> [--default]
  helm-cli remove-project <name>
  helm-cli list-projects
  helm-cli set-default <name>
  helm-cli help`);
}
