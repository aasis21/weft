// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, parse } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  clearTransportConfig,
  loadTransportConfig,
  saveTransportConfig,
  saveSupabaseCredentials,
  loadSupabaseCredentials,
  clearSupabaseCredentials,
  supabaseCredentialsPath,
  isPersistentPairingEnabled,
  savePairingMode,
  loadDefaultPermissionMode,
  saveDefaultPermissionMode,
  loadDeviceName,
  saveDeviceName,
  isTerminalEnabled,
  loadFileSharingConfig,
  saveFileSharingConfig,
  checkFileSharingPaths,
  loadFileSharingPolicy,
} from "../src/transportConfig.mjs";

let weftHome;

beforeEach(() => {
  weftHome = mkdtempSync(join(tmpdir(), "weft-home-"));
});

afterEach(() => {
  rmSync(weftHome, { recursive: true, force: true });
});

test("loadTransportConfig returns null when nothing is configured", () => {
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

test("terminal defaults on and preserves an explicit configuration opt-out", () => {
  assert.equal(isTerminalEnabled({ baseDir: weftHome }), true);
  const file = join(weftHome, "weft.config.json");
  writeFileSync(file, JSON.stringify({ terminal: { enabled: false } }));
  assert.equal(isTerminalEnabled({ baseDir: weftHome }), false);
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  assert.equal(isTerminalEnabled({ baseDir: weftHome }), false);
  writeFileSync(file, JSON.stringify({ terminal: { enabled: true } }));
  assert.equal(isTerminalEnabled({ baseDir: weftHome }), true);
});

test("invalid configuration cannot silently enable terminal access", () => {
  const file = join(weftHome, "weft.config.json");
  for (const value of ["{broken", "null", "[]", '{"terminal":null}', '{"terminal":{"enabled":"false"}}']) {
    writeFileSync(file, value);
    assert.throws(() => isTerminalEnabled({ baseDir: weftHome }), /configuration|terminal.enabled/);
  }
});

test("save/load round-trips a local descriptor", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "local" });
});

test("save/load round-trips a supabase descriptor as a bare pointer (creds live in supabase.json)", () => {
  // Inline url/anonKey are intentionally stripped: the pointer file records ONLY which kind the
  // user chose. Credentials are stored separately by saveSupabaseCredentials (below), so
  // switching transports back and forth never destroys them.
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "supabase" });
});

test("saveTransportConfig rejects an invalid descriptor", () => {
  assert.throws(() => saveTransportConfig({ kind: "bogus" }, { baseDir: weftHome }), /invalid transport descriptor/);
  assert.throws(() => saveTransportConfig(null, { baseDir: weftHome }), /invalid transport descriptor/);
});

test("a second save overwrites the first", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "supabase" });
});

test("clearTransportConfig removes the persisted choice", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

test("clearTransportConfig on an already-empty store is a no-op", () => {
  assert.doesNotThrow(() => clearTransportConfig({ baseDir: weftHome }));
});

test("saveTransportConfig merges into weft.config.json without clobbering other keys", () => {
  writeFileSync(join(weftHome, "weft.config.json"), JSON.stringify({ someOtherSetting: 42 }));
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { someOtherSetting: 42, transport: { kind: "local" } });
});

test("clearTransportConfig removes only the transport key, keeping other config", () => {
  writeFileSync(join(weftHome, "weft.config.json"), JSON.stringify({ someOtherSetting: 42 }));
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { someOtherSetting: 42 });
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

test("persistent pairing is enabled by default", () => {
  assert.equal(isPersistentPairingEnabled({ baseDir: weftHome }), true);
});

test("savePairingMode can explicitly opt out of and back into persistent pairing", () => {
  savePairingMode("ephemeral", { baseDir: weftHome });
  assert.equal(isPersistentPairingEnabled({ baseDir: weftHome }), false);
  savePairingMode("persistent", { baseDir: weftHome });
  assert.equal(isPersistentPairingEnabled({ baseDir: weftHome }), true);
});

test("session permissions default safely and persist without clobbering other config", () => {
  assert.equal(loadDefaultPermissionMode({ baseDir: weftHome }), "default");
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveDefaultPermissionMode("allow-all", { baseDir: weftHome });
  assert.equal(loadDefaultPermissionMode({ baseDir: weftHome }), "allow-all");
  assert.deepEqual(JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8")), {
    transport: { kind: "local" },
    launch: { defaultPermissionMode: "allow-all" },
  });
  saveDefaultPermissionMode("default", { baseDir: weftHome });
  assert.equal(loadDefaultPermissionMode({ baseDir: weftHome }), "default");
  assert.throws(
    () => saveDefaultPermissionMode("unsafe", { baseDir: weftHome }),
    /default permission mode/,
  );
});

test("malformed permission config fails closed to normal prompts", () => {
  writeFileSync(
    join(weftHome, "weft.config.json"),
    JSON.stringify({ launch: { defaultPermissionMode: "anything-else" } }),
  );
  assert.equal(loadDefaultPermissionMode({ baseDir: weftHome }), "default");
});

test("loadDeviceName returns null when nothing is configured", () => {
  assert.equal(loadDeviceName({ baseDir: weftHome }), null);
});

test("save/load round-trips a device name, trimmed", () => {
  saveDeviceName("  My Laptop  ", { baseDir: weftHome });
  assert.equal(loadDeviceName({ baseDir: weftHome }), "My Laptop");
});

test("saveDeviceName rejects an empty/whitespace-only name", () => {
  assert.throws(() => saveDeviceName("", { baseDir: weftHome }), /non-empty string/);
  assert.throws(() => saveDeviceName("   ", { baseDir: weftHome }), /non-empty string/);
});

test("saveDeviceName rejects a name over the length limit", () => {
  assert.throws(() => saveDeviceName("x".repeat(61), { baseDir: weftHome }), /60 characters or fewer/);
});

test("saveDeviceName merges into weft.config.json without clobbering the transport", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveDeviceName("My Laptop", { baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { transport: { kind: "local" }, deviceName: "My Laptop" });
});

// --- Supabase credentials live in a sibling file (~/.weft/supabase.json), independent of the
// pointer above. This lets the installer seed hosted defaults once and `weft set-transport
// supabase` (no flags) flip the pointer without asking for creds again. --------------------

test("loadSupabaseCredentials returns null when the file doesn't exist", () => {
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
});

test("saveSupabaseCredentials round-trips through loadSupabaseCredentials", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
  // File exists next to (not inside) weft.config.json.
  assert.ok(existsSync(supabaseCredentialsPath({ baseDir: weftHome })));
  assert.equal(supabaseCredentialsPath({ baseDir: weftHome }), join(weftHome, "supabase.json"));
});

test("saveSupabaseCredentials trims whitespace and rejects empty fields", () => {
  saveSupabaseCredentials({ url: "  https://x.supabase.co  ", anonKey: "  anon  " }, { baseDir: weftHome });
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
  assert.throws(() => saveSupabaseCredentials({ url: "", anonKey: "anon" }, { baseDir: weftHome }), /url must be a non-empty string/);
  assert.throws(() => saveSupabaseCredentials({ url: "https://x", anonKey: "   " }, { baseDir: weftHome }), /anonKey must be a non-empty string/);
});

test("loadSupabaseCredentials returns null for corrupt JSON or missing fields (never throws)", () => {
  const credsPath = supabaseCredentialsPath({ baseDir: weftHome });
  writeFileSync(credsPath, "{not valid json");
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
  writeFileSync(credsPath, JSON.stringify({ url: "https://x" }));  // missing anonKey
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
});

test("saveSupabaseCredentials does NOT touch weft.config.json (independent files)", () => {
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  const configBefore = readFileSync(join(weftHome, "weft.config.json"), "utf8");
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  const configAfter = readFileSync(join(weftHome, "weft.config.json"), "utf8");
  assert.equal(configBefore, configAfter);
});

test("clearTransportConfig does NOT delete supabase.json (creds outlive the pointer)", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  // Pointer is gone but creds are still on disk — flipping back is a one-liner without re-typing.
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("clearSupabaseCredentials removes supabase.json and is a no-op if already gone", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  clearSupabaseCredentials({ baseDir: weftHome });
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
  assert.doesNotThrow(() => clearSupabaseCredentials({ baseDir: weftHome }));
});

test("file sharing defaults off, merges centrally and survives other setting updates", () => {
  assert.deepEqual(loadFileSharingConfig({ baseDir: weftHome }), { enabled: false, roots: [], exclude: [] });
  const config = join(weftHome, "weft.config.json");
  const original = { transport: { kind: "local" }, terminal: { enabled: false },
    pairing: { persistent: true }, launch: { defaultPermissionMode: "default" }, deviceName: "Laptop" };
  writeFileSync(config, JSON.stringify(original));
  const files = { enabled: true, roots: [{ name: "Project", path: resolve(weftHome) }], exclude: ["**/secrets/**"] };
  saveFileSharingConfig(files, { baseDir: weftHome });
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...original, files });
  saveDeviceName("Renamed", { baseDir: weftHome });
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  savePairingMode("ephemeral", { baseDir: weftHome });
  assert.deepEqual(loadFileSharingConfig({ baseDir: weftHome }), files);
});

test("invalid file policy fails closed without overwriting existing user configuration", () => {
  const config = join(weftHome, "weft.config.json");
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  const before = readFileSync(config, "utf8");
  const root = { name: "Root", path: resolve(weftHome) };
  for (const files of [
    null, [], { enabled: "true" }, { enabled: true, roots: [] },
    { enabled: true, roots: [{ name: "Relative", path: "relative" }] },
    { enabled: true, roots: [root, root] },
    { enabled: true, roots: [{ name: "Drive", path: parse(resolve(weftHome)).root }] },
    { enabled: true, roots: [{ name: "Home", path: homedir() }] },
    { enabled: true, roots: [root], readOnly: false },
    ...["../outside/**", "!secret", "[abc]", "dir\\file", "**tail", "/absolute"].map((pattern) =>
      ({ enabled: true, roots: [root], exclude: [pattern] })),
  ]) {
    assert.throws(() => saveFileSharingConfig(files, { baseDir: weftHome }), /files configuration/);
    assert.equal(readFileSync(config, "utf8"), before);
  }
  for (const value of ["{broken", "[]", "null", '{"files":null}']) {
    writeFileSync(config, value);
    assert.throws(() => loadFileSharingConfig({ baseDir: weftHome }), /files configuration/);
  }
});

test("file allowlist uses path boundaries and root-relative exclusions without narrower-root bypass", async () => {
  const root = await realpath(weftHome), shared = join(root, "shared"), nested = join(shared, "private");
  mkdirSync(nested, { recursive: true });
  saveFileSharingConfig({ enabled: true, roots: [
    { name: "Shared", path: shared }, { name: "Nested", path: nested },
  ], exclude: ["private/**", "**/*.pem", "**/secrets/**", "temp?.txt"] }, { baseDir: weftHome });
  const paths = [join(shared, "readme.md"), join(root, "shared-elsewhere", "file.txt"),
    join(nested, "file.txt"), join(shared, "key.pem"), join(shared, "deep", "key.pem"),
    join(shared, "secrets"), join(shared, "deep", "secrets", "file.txt"), join(shared, "temp1.txt")];
  assert.deepEqual(await checkFileSharingPaths(paths, { baseDir: weftHome }),
    [true, false, false, false, false, false, false, false]);
  saveFileSharingConfig({ enabled: false, roots: [] }, { baseDir: weftHome });
  await assert.rejects(checkFileSharingPaths(paths, { baseDir: weftHome }), { code: "denied" });
});

test("an allowed repository includes only its verified registered worktrees and honors exclusions in them", async () => {
  const root = await realpath(weftHome), repo = join(root, "repo"), linked = join(root, "linked"), later = join(root, "later");
  const git = (...args) => execFileSync("git", args, { windowsHide: true, encoding: "utf8" });
  git("init", "--quiet", repo);
  writeFileSync(join(repo, "readme.md"), "base\n");
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  git("-C", repo, "worktree", "add", "--quiet", "--detach", linked);
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Repo", path: repo }], exclude: ["**/secrets/**"] }, { baseDir: weftHome });
  assert.deepEqual(await checkFileSharingPaths([
    join(repo, "readme.md"), join(linked, "readme.md"), join(later, "readme.md"),
    join(linked, "secrets", "key.txt"), join(root, "linked-sibling", "file.txt"),
  ], { baseDir: weftHome }), [true, true, false, false, false]);
  git("-C", repo, "worktree", "add", "--quiet", "--detach", later);
  assert.deepEqual(await checkFileSharingPaths([join(later, "readme.md")], { baseDir: weftHome }), [true]);
  git("-C", repo, "worktree", "remove", "--force", later);
  assert.deepEqual(await checkFileSharingPaths([join(later, "readme.md")], { baseDir: weftHome }), [false]);
  mkdirSync(join(repo, "subfolder"));
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Narrow", path: join(repo, "subfolder") }] }, { baseDir: weftHome });
  assert.deepEqual(await checkFileSharingPaths([join(repo, "readme.md"), join(linked, "readme.md")], { baseDir: weftHome }), [false, false]);
});

test("worktree registry entries are revalidated against the current repository identity", async () => {
  const root = await realpath(weftHome), repo = join(root, "repo"), linked = join(root, "linked");
  const git = (...args) => execFileSync("git", args, { windowsHide: true, encoding: "utf8" });
  git("init", "--quiet", repo);
  git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "base");
  git("-C", repo, "worktree", "add", "--quiet", "--detach", linked);
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Repo", path: repo }] }, { baseDir: weftHome });
  rmSync(join(linked, ".git"));
  git("init", "--quiet", linked);
  await assert.rejects(checkFileSharingPaths([join(linked, "file.md")], { baseDir: weftHome }), /no longer belongs/);
});

test("file sharing rejects missing roots and symbolic-link root aliases", async (t) => {
  const root = await realpath(weftHome);
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Missing", path: join(root, "missing") }] }, { baseDir: weftHome });
  await assert.rejects(checkFileSharingPaths([root], { baseDir: weftHome }), /missing or inaccessible/);
  const target = join(root, "target"), link = join(root, "alias");
  mkdirSync(target);
  try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Symlinks unavailable for this account."); return; } throw error; }
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Alias", path: link }] }, { baseDir: weftHome });
  await assert.rejects(checkFileSharingPaths([join(link, "file.md")], { baseDir: weftHome }), /symbolic-link aliases/);
});

test("file exclusions match glob segments and Unicode without expanding permissions", async () => {
  const root = await realpath(weftHome), shared = join(root, "shared");
  mkdirSync(shared);
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Shared", path: shared }],
    exclude: ["**/key?.pem", "exact/\u{1f600}.txt", "**/a.b"] }, { baseDir: weftHome });
  assert.deepEqual(await checkFileSharingPaths([
    join(shared, "key1.pem"), join(shared, "deep", "key2.pem"),
    join(shared, "key12.pem"), join(shared, "exact", "\u{1f600}.txt"),
    join(shared, "other", "\u{1f600}.txt"), join(shared, "a.b"), join(shared, "axb"),
  ], { baseDir: weftHome }), [false, false, true, false, true, false, true]);
});

test("central policy changes invalidate an in-flight policy snapshot", async () => {
  const root = await realpath(weftHome);
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Shared", path: root }] }, { baseDir: weftHome });
  const policy = await loadFileSharingPolicy({ baseDir: weftHome });
  saveFileSharingConfig({ enabled: false, roots: [] }, { baseDir: weftHome });
  await assert.rejects(policy.allows([join(root, "readme.md")]), { code: "changed" });
  await assert.rejects(checkFileSharingPaths([root], { baseDir: weftHome }), { code: "denied" });
});

test("a shared-root child symlink cannot expand access beyond its canonical boundary", async (t) => {
  const root = await realpath(weftHome), shared = join(root, "shared"), outside = join(root, "outside");
  mkdirSync(shared); mkdirSync(outside);
  const link = join(shared, "escape");
  try { symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("Symlinks unavailable for this account."); return; } throw error; }
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Shared", path: shared }] }, { baseDir: weftHome });
  assert.deepEqual(await checkFileSharingPaths([join(link, "missing.txt")], { baseDir: weftHome }), [false]);
});
