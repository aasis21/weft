// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_FILE = "projects.json";

export function weftHome(baseDir = process.env.WEFT_HOME) {
  return baseDir || join(homedir(), ".weft");
}

function storePath(baseDir) {
  return join(weftHome(baseDir), STORE_FILE);
}

function ensureDir(baseDir) {
  const dir = weftHome(baseDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // chmod is best-effort on Windows.
  }
  return dir;
}

function normalizeStore(raw) {
  const projects = Array.isArray(raw?.projects) ? raw.projects : [];
  let defaultSeen = false;
  return {
    projects: projects
      .filter((p) => p && typeof p.name === "string" && typeof p.path === "string")
      .map((p) => {
        const item = { name: p.name, path: p.path };
        if ((p.default === true || p.isDefault === true) && !defaultSeen) {
          item.default = true;
          defaultSeen = true;
        }
        return item;
      }),
  };
}

export function loadProjects({ baseDir } = {}) {
  const file = storePath(baseDir);
  try {
    return normalizeStore(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    if (err?.code === "ENOENT") return { projects: [] };
    throw new Error(`Weft projects: failed to read ${file}: ${err?.message ?? err}`);
  }
}

function saveProjects(store, { baseDir } = {}) {
  const dir = ensureDir(baseDir);
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.projects.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on Windows.
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on Windows.
  }
}

function cleanName(name) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("Project name is required");
  return value;
}

function existingDirectory(path) {
  const absolute = resolve(String(path ?? ""));
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Project path is not an existing directory: ${absolute}`);
  }
  return absolute;
}

function enforceSingleDefault(projects, defaultName = null) {
  let seen = false;
  for (const project of projects) {
    const isDefault = defaultName ? project.name === defaultName : project.default === true && !seen;
    if (isDefault) {
      project.default = true;
      seen = true;
    } else {
      delete project.default;
    }
  }
}

export function addProject(name, path, { makeDefault = false, baseDir } = {}) {
  const projectName = cleanName(name);
  const absolute = existingDirectory(path);
  const store = loadProjects({ baseDir });
  const previous = store.projects.find((p) => p.name === projectName);
  const projects = store.projects.filter((p) => p.name !== projectName);
  const shouldBeDefault = makeDefault || previous?.default === true;
  projects.push({ name: projectName, path: absolute, ...(shouldBeDefault ? { default: true } : {}) });
  enforceSingleDefault(projects, shouldBeDefault ? projectName : null);
  saveProjects({ projects }, { baseDir });
  return projects.find((p) => p.name === projectName);
}

export function removeProject(name, { baseDir } = {}) {
  const projectName = cleanName(name);
  const store = loadProjects({ baseDir });
  const projects = store.projects.filter((p) => p.name !== projectName);
  if (projects.length === store.projects.length) throw new Error(`Unknown project: ${projectName}`);
  saveProjects({ projects }, { baseDir });
  return { name: projectName };
}

export function setDefault(name, { baseDir } = {}) {
  const projectName = cleanName(name);
  const store = loadProjects({ baseDir });
  if (!store.projects.some((p) => p.name === projectName)) throw new Error(`Unknown project: ${projectName}`);
  enforceSingleDefault(store.projects, projectName);
  saveProjects(store, { baseDir });
  return store.projects.find((p) => p.name === projectName);
}

export function listProjects({ baseDir } = {}) {
  return loadProjects({ baseDir }).projects.map((p) => ({ ...p }));
}
