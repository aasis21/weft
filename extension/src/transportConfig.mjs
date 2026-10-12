// SPDX-License-Identifier: Apache-2.0
// Central user configuration: ~/.weft/weft.config.json holds transport, pairing, device,
// terminal, and file-sharing settings. The transport's own
// connection details live in a sibling file named after the transport itself:
//   - kind: "supabase"  → ~/.weft/supabase.json  ({url, anonKey})
//   - kind: "devtunnel" → ~/.weft/devtunnel.json (runtime registry written by the relay child,
//                                                  see devtunnel.mjs — not user config)
// Mirrors projects.mjs's storage pattern (same ~/.weft home, same atomic-write-then-rename) so
// both the Copilot CLI extension (extension.mjs) and the device-station CLI (weft.mjs) pick up
// whatever transport the user configured via `weft set-transport`. There is NO env var override
// for any of this (no WEFT_TRANSPORT, no .env) — a reinstall/rebuild only ever touches installed
// code under ~/.copilot/extensions/weft, never these files, so it can never silently clobber the
// user's choice or credentials. The config file is always read fresh; nothing here falls back to
// process.env.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { realpath, lstat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, parse, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { weftHome } from "./projects.mjs";

const STORE_FILE = "weft.config.json";
const SUPABASE_CREDS_FILE = "supabase.json";
const exec = promisify(execFile);

function storePath(baseDir) {
  return join(weftHome(baseDir), STORE_FILE);
}

function supabaseCredsPath(baseDir) {
  return join(weftHome(baseDir), SUPABASE_CREDS_FILE);
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

/** Same shape validation as shared/pairing.mjs's isValidTransportDescriptor. "local" is accepted
 * here for the harness/tests but not offered by any user-facing command (see
 * transportFactory.mjs's SUPPORTED_TRANSPORT_NAMES). Both "supabase" and "devtunnel" persist as
 * bare markers (no connection details inline): supabase's url/anonKey live in the sibling
 * supabase.json (see saveSupabaseCredentials below); devtunnel's live relay URL is looked up
 * from the running relay's devtunnel.json at resolve time by resolveTransport() (see
 * transportFactory.mjs), never stored. */
function isValidTransportDescriptor(t) {
  if (!t || typeof t !== "object") return false;
  if (t.kind === "local") return true;
  if (t.kind === "devtunnel") return true;
  if (t.kind === "supabase") return true;
  return false;
}

/** Read the whole config object (weft.config.json), or {} if unset/unreadable/invalid. Kept
 * generic — beyond `transport`, other user-facing settings can be added here over time — so this
 * one file stays the single place a user's ~/.weft config lives. */
function loadConfig({ baseDir, strict = false } = {}) {
  const file = storePath(baseDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (strict && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error("Invalid configuration object");
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (strict && error.code !== "ENOENT") {
      throw new Error("Weft: cannot read a valid weft.config.json. Fix the configuration before starting Device Station.");
    }
    return {};
  }
}

/** Terminal access defaults on; a malformed configuration must never override an opt-out. */
export function isTerminalEnabled({ baseDir } = {}) {
  const { terminal } = loadConfig({ baseDir, strict: true });
  if (terminal === undefined) return true;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal) ||
      (terminal.enabled !== undefined && typeof terminal.enabled !== "boolean")) {
    throw new Error("Weft: terminal.enabled in weft.config.json must be true or false.");
  }
  return terminal.enabled !== false;
}

export class FileSharingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fileConfigError = (message) => {
  throw new FileSharingError("unavailable", `Weft: ${message} in files configuration. Fix ~/.weft/weft.config.json before sharing files.`);
};
const pathKey = (path) => process.platform === "win32" ? path.toLowerCase() : path;
const isInside = (root, path) => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

function matchFileSegment(pattern, name) {
  const points = [...name];
  let matches = new Array(points.length + 1).fill(false);
  matches[0] = true;
  for (const char of pattern) {
    if (char === "*") {
      for (let i = 1; i <= points.length; i++) matches[i] ||= matches[i - 1];
    } else {
      const next = new Array(points.length + 1).fill(false);
      for (let i = 1; i <= points.length; i++) {
        next[i] = matches[i - 1] && (char === "?" || char === points[i - 1]);
      }
      matches = next;
    }
  }
  return matches[points.length];
}

function exclusionPattern(value) {
  if (typeof value !== "string" || !value || value.length > 256 ||
      /[\0\r\n\\[\]{}!()]/.test(value) || isAbsolute(value) ||
      value.split("/").some((part) => !part || part === "." || part === ".." || part.includes("**") && part !== "**")) {
    fileConfigError("Use root-relative exclude patterns with /, *, ? and whole-segment ** only");
  }
  const pattern = pathKey(value).split("/");
  return { test(path) {
    const parts = pathKey(path).split("/").filter(Boolean);
    let matches = new Array(parts.length + 1).fill(false);
    matches[0] = true;
    for (const segment of pattern) {
      if (segment === "**") {
        for (let i = 1; i <= parts.length; i++) matches[i] ||= matches[i - 1];
      } else {
        const next = new Array(parts.length + 1).fill(false);
        for (let i = 1; i <= parts.length; i++) {
          next[i] = matches[i - 1] && matchFileSegment(segment, parts[i - 1]);
        }
        matches = next;
      }
    }
    return matches[parts.length];
  } };
}

function validateFileSharingConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["enabled", "roots", "exclude"].includes(key)) ||
      value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fileConfigError("Expected enabled (boolean), roots and exclude");
  }
  const roots = value.roots ?? [], exclude = value.exclude ?? [];
  if (!Array.isArray(roots) || roots.length > 32 || !Array.isArray(exclude) || exclude.length > 64) {
    fileConfigError("At most 32 roots and 64 exclusion patterns are supported");
  }
  if (value.enabled === true && !roots.length) fileConfigError("At least one explicit root is required when enabled");
  const names = new Set(), paths = new Set();
  const normalizedRoots = roots.map((root) => {
    if (!root || typeof root !== "object" || Array.isArray(root) ||
        Object.keys(root).some((key) => !["name", "path"].includes(key)) ||
        typeof root.name !== "string" || !root.name.trim() || root.name.trim().length > 60 ||
        /[\0\r\n]/.test(root.name) || typeof root.path !== "string" ||
        root.path.length > 2048 || !isAbsolute(root.path) || /[\0\r\n]/.test(root.path) ||
        /^(?:\\\\|\/\/)/.test(root.path)) fileConfigError("Each root requires a name and an absolute local directory path");
    if (process.platform === "win32" && (root.path.replace(/^[a-z]:/i, "").includes(":") ||
        root.path.split(/[\\/]/).some((part) => /[. ]$/.test(part)))) {
      fileConfigError("Root paths cannot contain alternate streams or trailing-dot/space aliases");
    }
    const name = root.name.trim(), path = resolve(root.path), key = pathKey(path);
    if (key === pathKey(parse(path).root) || key === pathKey(resolve(homedir()))) {
      fileConfigError("Share a narrower directory, not an entire drive or home directory");
    }
    if (names.has(name.toLowerCase()) || paths.has(key)) fileConfigError("Root names and paths must be unique");
    names.add(name.toLowerCase()); paths.add(key);
    return { name, path };
  });
  for (const pattern of exclude) exclusionPattern(pattern);
  return { enabled: value.enabled === true, roots: normalizedRoots, exclude: [...exclude] };
}

export function loadFileSharingConfig({ baseDir } = {}) {
  let config;
  try { config = loadConfig({ baseDir, strict: true }); }
  catch { fileConfigError("Cannot read a valid central user configuration"); }
  return config.files === undefined ? { enabled: false, roots: [], exclude: [] } :
    validateFileSharingConfig(config.files);
}

export function saveFileSharingConfig(value, { baseDir } = {}) {
  const files = validateFileSharingConfig(value);
  const config = loadConfig({ baseDir, strict: true });
  writeConfig({ ...config, files }, { baseDir });
  return files;
}

async function canonicalSharedDirectory(path) {
  let canonical, info;
  try { canonical = await realpath(path); info = await lstat(path); }
  catch { fileConfigError("A configured root is missing or inaccessible"); }
  if (!info.isDirectory() || info.isSymbolicLink() || pathKey(canonical) !== pathKey(path)) {
    fileConfigError("Roots must be canonical directories without symbolic-link aliases");
  }
  return canonical;
}

async function gitSharingMetadata(root, args) {
  try {
    const { stdout } = await exec("git", ["--no-pager", "--literal-pathspecs",
      "-c", "core.fsmonitor=false", "-C", root, ...args], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: "buffer",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch { fileConfigError("Git worktree membership could not be verified"); }
}

async function gitSharingIdentity(root) {
  const values = (await gitSharingMetadata(root, [
    "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir",
  ])).trimEnd().split(/\r?\n/);
  if (values.length !== 2 || !isAbsolute(values[0]) || !isAbsolute(values[1])) {
    fileConfigError("Git returned an invalid repository identity");
  }
  try { return { top: await realpath(values[0]), common: await realpath(values[1]) }; }
  catch { fileConfigError("Git repository identity paths are unavailable"); }
}

async function registeredSharingWorktrees(root, issues, requestedPaths, registries, checkedWorktrees) {
  const key = pathKey(root);
  if (!registries.has(key)) {
    const loading = (async () => {
      try { await lstat(join(root, ".git")); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        fileConfigError("Git repository metadata is inaccessible");
      }
      const identity = await gitSharingIdentity(root);
      if (pathKey(identity.top) !== key) return null;
      const raw = (await gitSharingMetadata(root, ["worktree", "list", "--porcelain", "-z"]))
        .split("\0\0").filter(Boolean);
      if (raw.length > 128) fileConfigError("A repository has too many registered worktrees");
      const records = [];
      for (const record of raw) {
        const fields = record.split("\0").filter(Boolean), first = fields[0];
        if (!first?.startsWith("worktree ")) {
          issues.push({ path: root, message: "Git returned an invalid worktree registry entry." });
          continue;
        }
        if (fields.some((field) => field === "bare" || field.startsWith("prunable"))) continue;
        const path = first.slice("worktree ".length);
        if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
          issues.push({ path: root, message: "Git returned an invalid worktree path." });
          continue;
        }
        records.push(path);
      }
      if (!records.some((path) => pathKey(resolve(path)) === key)) {
        fileConfigError("The configured root is missing from its Git worktree registry");
      }
      return { identity, records };
    })().catch((error) => {
      if (!(error instanceof FileSharingError)) throw error;
      issues.push({ path: root, message: error.message });
      return null;
    });
    registries.set(key, loading);
  }
  const registry = await registries.get(key);
  if (!registry) return [];
  const roots = [];
  for (const path of registry.records) {
    const candidate = resolve(path);
    if (pathKey(candidate) === key || !requestedPaths.some((target) => isInside(candidate, target))) continue;
    const candidateKey = JSON.stringify([key, pathKey(candidate)]);
    if (checkedWorktrees.has(candidateKey)) continue;
    checkedWorktrees.add(candidateKey);
    try {
      const validated = validateFileSharingConfig({ enabled: true, roots: [{ name: "Worktree", path }] }).roots[0].path;
      const canonical = await canonicalSharedDirectory(validated);
      const actual = await gitSharingIdentity(canonical);
      if (pathKey(actual.top) !== pathKey(canonical) || pathKey(actual.common) !== pathKey(registry.identity.common)) {
        fileConfigError("A registered worktree no longer belongs to its configured repository");
      }
      roots.push(canonical);
    } catch (error) {
      if (!(error instanceof FileSharingError)) throw error;
      issues.push({ path, message: error.message });
    }
  }
  return roots;
}

export async function loadFileSharingPolicy({ baseDir } = {}) {
  const config = loadFileSharingConfig({ baseDir });
  const revision = JSON.stringify(config);
  if (!config.enabled) {
    throw new FileSharingError("denied", "File sharing is disabled. Configure files.enabled and explicit files.roots in ~/.weft/weft.config.json.");
  }
  const roots = new Map(), configuredRoots = [], worktreeIssues = [],
    registries = new Map(), checkedWorktrees = new Set();
  for (const root of config.roots) {
    const canonical = await canonicalSharedDirectory(root.path);
    roots.set(pathKey(canonical), canonical);
    configuredRoots.push(canonical);
  }
  const excluded = config.exclude.map(exclusionPattern);
  return { worktreeIssues, async allows(paths) {
    if (JSON.stringify(loadFileSharingConfig({ baseDir })) !== revision) {
      throw new FileSharingError("changed", "File-sharing settings changed. Retry with the current policy.");
    }
    const outside = paths.filter((path) => typeof path === "string" && isAbsolute(path) &&
      !/[\0\r\n]/.test(path) && !/^(?:\\\\|\/\/)/.test(path))
      .map((path) => resolve(path)).filter((path) => ![...roots.values()].some((root) => isInside(root, path)));
    if (outside.length) {
      for (const canonical of configuredRoots) {
        for (const worktree of await registeredSharingWorktrees(canonical, worktreeIssues, outside, registries, checkedWorktrees)) {
          if (roots.has(pathKey(worktree))) continue;
          if (roots.size >= 128) {
            worktreeIssues.push({ path: worktree, message: "The effective sharing-root limit was reached. This worktree is not shared." });
          } else roots.set(pathKey(worktree), worktree);
        }
      }
    }
    const allowed = [];
    for (const path of paths) {
      if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path) || /^(?:\\\\|\/\/)/.test(path) ||
          process.platform === "win32" && (path.replace(/^[a-z]:/i, "").includes(":") ||
          path.split(/[\\/]/).some((part) => /[. ]$/.test(part)))) {
        allowed.push(false); continue;
      }
      const target = resolve(path), containing = [...roots.values()].filter((root) => isInside(root, target));
      let excludedPath = !containing.length || containing.some((root) => {
        const parts = relative(root, target).split(sep).filter(Boolean);
        for (let i = 0; i <= parts.length; i++) {
          const name = parts.slice(0, i).join("/");
          if (excluded.some((pattern) => pattern.test(name))) return true;
        }
        return false;
      });
      if (!excludedPath) {
        let ancestor = target;
        for (;;) {
          try {
            const canonical = await realpath(ancestor);
            excludedPath = pathKey(canonical) !== pathKey(ancestor);
            break;
          } catch (error) {
            if (error.code !== "ENOENT") fileConfigError("A requested shared path could not be verified");
            if (dirname(ancestor) === ancestor) { excludedPath = true; break; }
            ancestor = dirname(ancestor);
          }
        }
      }
      allowed.push(!excludedPath);
    }
    return allowed;
  } };
}

export async function checkFileSharingPaths(paths, options = {}) {
  return (await loadFileSharingPolicy(options)).allows(paths);
}

/** Atomically overwrite weft.config.json with `config`. */
function writeConfig(config, { baseDir } = {}) {
  const dir = ensureDir(baseDir);
  const file = join(dir, STORE_FILE);
  const tmp = join(dir, `.weft.config.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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

/** Read the persisted transport descriptor, or null if unset/unreadable/invalid. */
export function loadTransportConfig({ baseDir } = {}) {
  const { transport } = loadConfig({ baseDir });
  return isValidTransportDescriptor(transport) ? transport : null;
}

/** Persist a transport descriptor as the user's chosen default (`weft set-transport`). Merges
 * into weft.config.json rather than overwriting it, so other config keys survive. For
 * "supabase", the descriptor is a bare `{kind: "supabase"}` marker — url/anonKey are stored
 * separately via saveSupabaseCredentials so the pointer and the creds have independent
 * lifecycles (installer seeds the creds once; `set-transport supabase` flips the pointer
 * without touching them; overrides pass fresh --url/--anon-key to overwrite the creds file). */
export function saveTransportConfig(descriptor, { baseDir } = {}) {
  if (!isValidTransportDescriptor(descriptor)) {
    throw new Error(
      'Weft: invalid transport descriptor (kind must be "supabase" or "devtunnel" — or, for ' +
        'harness/testing use, "local")',
    );
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, transport: { kind: descriptor.kind } }, { baseDir });
  return { kind: descriptor.kind };
}

/** Persist the Supabase URL + anon key to ~/.weft/supabase.json (atomic, 0600). This is the
 * ONLY place these credentials are written; the pointer file (weft.config.json) never carries
 * them. Both fields are required together — a partial write would leave the file in an
 * unresolvable half-state at pairing time. */
export function saveSupabaseCredentials({ url, anonKey }, { baseDir } = {}) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("Weft: supabase url must be a non-empty string");
  }
  if (typeof anonKey !== "string" || !anonKey.trim()) {
    throw new Error("Weft: supabase anonKey must be a non-empty string");
  }
  const dir = ensureDir(baseDir);
  const file = join(dir, SUPABASE_CREDS_FILE);
  const tmp = join(dir, `.supabase.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }, null, 2)}\n`, { mode: 0o600 });
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
  return { url: url.trim(), anonKey: anonKey.trim() };
}

/** Read the persisted Supabase credentials, or null if the file is missing/unreadable/invalid.
 * Callers that need to resolve a live transport should treat null as "credentials not
 * installed" and throw an actionable, path-mentioning error — see transportFactory.mjs. */
export function loadSupabaseCredentials({ baseDir } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(supabaseCredsPath(baseDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.url !== "string" || typeof parsed.anonKey !== "string") return null;
    return { url: parsed.url, anonKey: parsed.anonKey };
  } catch {
    return null;
  }
}

/** Absolute path of the Supabase credentials file, for building actionable error messages. */
export function supabaseCredentialsPath({ baseDir } = {}) {
  return supabaseCredsPath(baseDir);
}

/** Delete ~/.weft/supabase.json outright. Not called on `set-transport clear` (clearing the
 * pointer intentionally leaves stored creds in place so switching back is a one-liner); provided
 * for tests and future explicit "forget credentials" commands. */
export function clearSupabaseCredentials({ baseDir } = {}) {
  try {
    unlinkSync(supabaseCredsPath(baseDir));
  } catch {
    // Already absent — nothing to do.
  }
}

/** Remove the persisted transport CHOICE (other config keys are left untouched, and stored
 * Supabase credentials at ~/.weft/supabase.json are left in place — clearing the pointer is
 * deliberately a lightweight action, not a "forget everything" nuke). After clearing, resolving
 * a transport requires running `weft set-transport` again to pick a kind. */
export function clearTransportConfig({ baseDir } = {}) {
  const config = loadConfig({ baseDir });
  if (!("transport" in config)) return;
  delete config.transport;
  if (Object.keys(config).length === 0) {
    try {
      unlinkSync(storePath(baseDir));
    } catch {
      // Already absent, or unreadable — either way there's nothing to clear.
    }
    return;
  }
  writeConfig(config, { baseDir });
}

/** True unless the user explicitly opted into ephemeral pairing (`weft set-pairing ephemeral`).
 * Persistent pairing is the default for `weft start`: it reuses the same channelId + keypair from
 * pairingIdentity.mjs so an already-paired phone reconnects without rescanning. */
export function isPersistentPairingEnabled({ baseDir } = {}) {
  return loadConfig({ baseDir })?.pairing?.persistent !== false;
}

/** Persist the pairing mode (`persistent` or `ephemeral`) as this device's default going forward.
 * Merges into weft.config.json rather than overwriting it, same as saveTransportConfig. */
export function savePairingMode(mode, { baseDir } = {}) {
  if (mode !== "persistent" && mode !== "ephemeral") {
    throw new Error('Weft: pairing mode must be "persistent" or "ephemeral"');
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, pairing: { persistent: mode === "persistent" } }, { baseDir });
  return mode;
}

/** Safe launch default advertised by Device Station to the phone. Missing or malformed values
 * always fall back to normal permission prompts rather than accidentally escalating access. */
export function loadDefaultPermissionMode({ baseDir } = {}) {
  const { launch } = loadConfig({ baseDir });
  return launch?.defaultPermissionMode === "allow-all" ? "allow-all" : "default";
}

/** Persist the permission mode selected by default on the phone's Start/Resume screen. */
export function saveDefaultPermissionMode(mode, { baseDir } = {}) {
  if (mode !== "default" && mode !== "allow-all") {
    throw new Error('Weft: default permission mode must be "default" or "allow-all"');
  }
  const config = loadConfig({ baseDir });
  const launch = config.launch && typeof config.launch === "object" && !Array.isArray(config.launch)
    ? config.launch
    : {};
  writeConfig({ ...config, launch: { ...launch, defaultPermissionMode: mode } }, { baseDir });
  return mode;
}

const MAX_DEVICE_NAME_LENGTH = 60;

/** Read the user-chosen display name for this device (`weft set-name`), or null if unset —
 * callers (listener.mjs, weft.mjs's `weft start` header) fall back to os.hostname() themselves so
 * this module has no opinion about the default. Set during install (install.ps1/install.sh
 * prompt, defaulting to the machine hostname) or any time after via `weft set-name`. */
export function loadDeviceName({ baseDir } = {}) {
  const { deviceName } = loadConfig({ baseDir });
  return typeof deviceName === "string" && deviceName.trim() ? deviceName.trim() : null;
}

/** Persist this device's display name (shown to phones as the DEVICES entry / senderName on
 * every message this listener sends). Merges into weft.config.json, same as saveTransportConfig. */
export function saveDeviceName(name, { baseDir } = {}) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new Error("Weft: device name must be a non-empty string");
  if (trimmed.length > MAX_DEVICE_NAME_LENGTH) {
    throw new Error(`Weft: device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer`);
  }
  const config = loadConfig({ baseDir });
  writeConfig({ ...config, deviceName: trimmed }, { baseDir });
  return trimmed;
}
