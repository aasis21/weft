// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorkspaceView } from "../src/workspaceView.mjs";
import { WORKSPACE_LIMITS } from "@aasis21/weft-shared";
import { saveFileSharingConfig } from "../src/transportConfig.mjs";

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "weft-workspace-")));
  const configBaseDir = join(root, ".weft");
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Workspace", path: root }] }, { baseDir: configBaseDir });
  t.after(() => rm(root, { recursive: true, force: true }));
  const excluded = new Set(), denied = new Set(), checked = [], approvals = [], events = [];
  let available = true, approve = true, primary = root, time = Date.now();
  const session = { rpc: {
    eventLog: { read: async ({ cursor, max }) => {
      const start = Number(cursor ?? 0), end = Math.min(events.length, start + max);
      return { cursorStatus: "ok", cursor: String(end), hasMore: end < events.length, events: events.slice(start, end) };
    } },
    permissions: { paths: {
      list: async () => ({ primary }),
      isPathWithinAllowedDirectories: async ({ path }) => ({ allowed: !denied.has(path) }),
    } },
    contentExclusion: { checkPaths: async ({ paths }) => {
      checked.push(...paths);
      return { available, checks: available ? paths.map((path) => ({ path, excluded: excluded.has(path) })) : [] };
    } },
  } };
  let view;
  view = await createWorkspaceView({
    session, clock: () => time, configBaseDir,
    requestPermission: async (args) => {
      approvals.push(args);
      if (approve) await view.grant(args);
    },
    ...options,
  });
  t.after(() => view.close());
  let n = 0;
  const request = (value) => view.handle({ ...value, requestId: `test-${++n}` });
  const file = async (path, text) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
    events.push({ type: "tool.execution_complete", data: {
      success: true, toolCallId: `file-${events.length}`, fileEdits: [{ path: join(root, path), kind: "create" }],
    } });
  };
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return { root, configBaseDir, session, view, request, file, git, checked, excluded, denied, approvals, events,
    policy(value) { available = value; }, approve(value) { approve = value; },
    primary(value) { primary = value; }, tick(value) { time += value; } };
}

test("keeps current-folder and session-touched listings separate, lazy and policy-filtered", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await f.file("folder/nested.md", "# nested");
  await f.file("root.txt", "not in the listing");
  await f.file(".env", "never shared");
  await f.file(".git/private-data", "never shared");
  await f.file("restricted.md", "never shared");
  f.excluded.add(join(f.root, "restricted.md"));
  await writeFile(join(f.root, "untouched.md"), "never shared");
  const page = await f.request({ action: "list", scope: "touched", path: "" });
  assert.deepEqual(page.entries.map((entry) => entry.path), ["folder/nested.md", "root.txt"]);
  assert.doesNotMatch(JSON.stringify(page), /not in the listing|untouched|restricted|never shared/);
  assert.equal(f.approvals.length, 1);
  assert.equal(page.scope, "touched");
  assert.equal(f.approvals[0].scope, "touched");
  await assert.rejects(f.request({ action: "list", scope: "touched", path: "folder" }), { code: "denied" });
  const current = await f.request({ action: "list", scope: "workspace", path: "" });
  assert.deepEqual(current.entries.map((entry) => entry.path), ["folder", "root.txt", "untouched.md"]);
  assert.equal(current.scope, "workspace");
  assert.equal(f.approvals.at(-1).scope, "workspace");
  assert.doesNotMatch(JSON.stringify(current), /nested.md|restricted|never shared|not in the listing/);
  const child = await f.request({ action: "list", scope: "workspace", path: "folder" });
  assert.deepEqual(child.entries.map((entry) => entry.path), ["folder/nested.md"]);
  assert.equal((await f.request({ action: "open", path: "untouched.md" })).text, "never shared");
});

test("directory pagination is bounded and rejects changed cursors", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 110 }, (_, n) => f.file(`${String(n).padStart(3, "0")}.txt`, "x")));
  const first = await f.request({ action: "list", path: "." });
  assert.ok(first.entries.length > 0 && first.entries.length <= 100);
  let count = first.entries.length, cursor = first.cursor;
  while (cursor) {
    const next = await f.request({ action: "list", path: ".", cursor });
    count += next.entries.length; cursor = next.cursor;
  }
  assert.equal(count, 110);
  await f.file("new.txt", "new");
  await assert.rejects(f.request({ action: "list", path: ".", cursor: first.cursor }), { code: "changed" });
});

test("listing cursors cannot be reused between the two scopes or different folders", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 110 }, (_, n) => f.file(`${n}.txt`, "x")));
  await f.file("folder/child.md", "child");
  const current = await f.request({ action: "list", scope: "workspace", path: "" });
  await assert.rejects(f.request({ action: "list", scope: "touched", path: "", cursor: current.cursor }), { code: "changed" });
  await assert.rejects(f.request({ action: "list", scope: "workspace", path: "folder", cursor: current.cursor }), { code: "changed" });
  const touched = await f.request({ action: "list", scope: "touched", path: "" });
  await assert.rejects(f.request({ action: "list", scope: "workspace", path: "", cursor: touched.cursor }), { code: "changed" });
});

test("all reads fail closed for permissions, policy outages, traversal and scope changes", async (t) => {
  const f = await fixture(t);
  await f.file("allowed.md", "content");
  f.approve(false);
  await assert.rejects(f.request({ action: "open", path: "allowed.md" }), { code: "denied" });
  f.approve(true);
  f.policy(false);
  await assert.rejects(f.request({ action: "list", path: "" }), { code: "unavailable" });
  f.policy(true);
  f.denied.add(join(f.root, "allowed.md"));
  await assert.rejects(f.request({ action: "open", path: "allowed.md" }), { code: "denied" });
  for (const path of ["../outside", ".git/config", ".env", "\\\\server\\file", "file:///etc/passwd"]) {
    await assert.rejects(f.request({ action: "open", path }), { code: "denied" });
  }
  if (process.platform === "win32") {
    for (const path of ["allowed.md:hidden", ".git./config", ".env."]) {
      await assert.rejects(f.request({ action: "open", path }), { code: "denied" });
    }
  }
  f.primary(join(f.root, "different"));
  await assert.rejects(f.request({ action: "list", path: "" }), { code: "changed" });
});

test("symlinks are not followed or listed as accessible files", async (t) => {
  const f = await fixture(t);
  await f.file("target.txt", "private");
  try { await symlink(join(f.root, "target.txt"), join(f.root, "link.txt")); }
  catch (error) { if (error.code === "EPERM") { t.skip("This Windows account cannot create symlinks."); return; } throw error; }
  await assert.rejects(f.request({ action: "open", path: "link.txt" }), { code: "denied" });
  assert.equal((await f.request({ action: "list", path: "" })).entries.some((entry) => entry.name === "link.txt"), false);
});

test("snapshot pages stay at one revision, handle Unicode, and expire without rereading changed text", async (t) => {
  const f = await fixture(t);
  const original = "😀 first\n".repeat(1200);
  await f.file("large.txt", original);
  const opened = await f.request({ action: "open", path: "large.txt" });
  assert.ok(opened.nextOffset !== null);
  assert.ok(Buffer.byteLength(opened.text) <= WORKSPACE_LIMITS.pageBytes);
  await f.file("large.txt", "replacement");
  let text = opened.text, next = opened.nextOffset;
  while (next !== null) {
    const page = await f.request({ action: "page", previewId: opened.previewId, offset: next });
    assert.equal(page.revision, opened.revision);
    text += page.text; next = page.nextOffset;
  }
  assert.equal(text, original);
  f.tick(WORKSPACE_LIMITS.ttlMs + 1);
  await assert.rejects(f.request({ action: "page", previewId: opened.previewId, offset: 0 }), { code: "expired" });
});

test("size, encoding, and HTML limits never silently truncate", async (t) => {
  const f = await fixture(t);
  await f.file("big.txt", "x".repeat(WORKSPACE_LIMITS.fileBytes + 1));
  await f.file("big.html", "x".repeat(WORKSPACE_LIMITS.htmlBytes + 1));
  await f.file("binary.txt", Buffer.from([0, 1, 2]));
  await f.file("nonutf8.txt", Buffer.from([255]));
  for (const path of ["big.txt", "big.html"]) await assert.rejects(f.request({ action: "open", path }), { code: "too-large" });
  for (const path of ["binary.txt", "nonutf8.txt"]) await assert.rejects(f.request({ action: "open", path }), { code: "unsupported" });
});

test("Changes pins HEAD, includes staged/unstaged/new/deleted files, and diffs without altering Git", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await f.file("tracked.txt", "old\n"); await f.file("deleted.txt", "old\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await f.file("tracked.txt", "staged\n"); f.git("add", "tracked.txt");
  await f.file("tracked.txt", "working\n"); await rm(join(f.root, "deleted.txt"));
  await f.file("new.txt", "new\n");
  const before = f.git("status", "--porcelain");
  const changes = await f.request({ action: "changes" });
  assert.ok(changes.entries.some((entry) => entry.path === "new.txt" && entry.status === "?"));
  assert.ok(changes.entries.some((entry) => entry.path === "deleted.txt" && entry.status === "D"));
  const diff = await f.request({ action: "open", path: "tracked.txt", format: "diff", base: changes.base });
  assert.match(diff.text, /\+working/); assert.match(diff.text, /-old/); assert.doesNotMatch(diff.text, /\+staged/);
  const deleted = await f.request({ action: "open", path: "deleted.txt", format: "diff", base: changes.base });
  assert.match(deleted.text, /-old/);
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(await readFile(join(f.root, "tracked.txt"), "utf8"), "working\n");
});

test("a native permission result cannot forge an inactive request", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.view.grant({ requestId: "not-pending", action: "open", path: "file.txt" }), { code: "denied" });
});

test("native listing approval cannot switch a pending request to the other tree", async (t) => {
  let view;
  const f = await fixture(t, { requestPermission: async (args) => {
    await assert.rejects(view.grant({ ...args, scope: args.scope === "workspace" ? "touched" : "workspace" }), { code: "denied" });
    return view.grant(args);
  } });
  view = f.view;
  await f.file("report.md", "report");
  await f.request({ action: "list", scope: "workspace", path: "" });
  await f.request({ action: "list", scope: "touched", path: "" });
});

test("availability checks a real workspace path without reading or requesting approval", async (t) => {
  const f = await fixture(t);
  f.session.rpc.contentExclusion.checkPaths = async ({ paths }) =>
    ({ available: paths.length === 0, checks: [] });
  await assert.rejects(f.view.checkAvailable(), {
    code: "unavailable", message: /Restart or update Copilot/,
  });
  assert.equal(f.approvals.length, 0);
  f.session.rpc.contentExclusion.checkPaths = async ({ paths }) =>
    ({ available: true, checks: paths.map((path) => ({ path, excluded: false })) });
  await f.view.checkAvailable();
  f.denied.add(f.root);
  await assert.rejects(f.view.checkAvailable(), { code: "denied" });
  assert.equal(f.approvals.length, 0);
});

test("policy changes revoke existing snapshot pages and omit denied entries", async (t) => {
  const f = await fixture(t);
  await f.file("visible.txt", "first\n".repeat(1000));
  await f.file("denied.txt", "private");
  f.denied.add(join(f.root, "denied.txt"));
  assert.equal((await f.request({ action: "list", path: "" })).entries.some((entry) => entry.name === "denied.txt"), false);
  const opened = await f.request({ action: "open", path: "visible.txt" });
  f.excluded.add(join(f.root, "visible.txt"));
  await assert.rejects(f.request({ action: "page", previewId: opened.previewId, offset: opened.nextOffset }), { code: "denied" });
});

test("nested workspace diffs never expose sibling repository paths", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await f.file("scope/inside.txt", "old\n"); await f.file("scope/deleted.txt", "old\n"); await f.file("outside.txt", "old\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await f.file("scope/inside.txt", "new\n"); await rm(join(f.root, "scope", "deleted.txt")); await f.file("outside.txt", "private\n");
  const primary = join(f.root, "scope");
  const session = { rpc: {
    eventLog: f.session.rpc.eventLog,
    permissions: { paths: { list: async () => ({ primary }), isPathWithinAllowedDirectories: async () => ({ allowed: true }) } },
    contentExclusion: { checkPaths: async ({ paths }) => ({ available: true, checks: paths.map((path) => ({ path, excluded: false })) }) },
  } };
  let view;
  view = await createWorkspaceView({ session, configBaseDir: f.configBaseDir, requestPermission: (args) => view.grant(args) });
  t.after(() => view.close());
  const changes = await view.handle({ requestId: "nested", action: "changes" });
  assert.deepEqual(changes.entries.map((entry) => entry.path), ["deleted.txt", "inside.txt"]);
  const diff = await view.handle({ requestId: "nested-open", action: "open", path: "inside.txt", format: "diff", base: changes.base });
  assert.match(diff.text, /\+new/);
  assert.doesNotMatch(diff.text, /outside|private/);
  const deleted = await view.handle({ requestId: "nested-delete", action: "open", path: "deleted.txt", format: "diff", base: changes.base });
  assert.match(deleted.text, /-old/);
});

test("renamed-file diffs authorize both paths and revoked old paths cannot be paged", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  const original = "line\n".repeat(1000);
  await f.file("old.txt", original);
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  f.git("mv", "old.txt", "new.txt");
  await f.file("new.txt", original + "added\n".repeat(300));
  const changes = await f.request({ action: "changes" });
  const renamed = changes.entries.find((entry) => entry.status === "R");
  assert.ok(renamed);
  const diff = await f.request({ action: "open", path: "new.txt", format: "diff", base: changes.base });
  assert.match(diff.text, /old.txt/);
  assert.ok(diff.nextOffset !== null);
  f.excluded.add(join(f.root, "old.txt"));
  await assert.rejects(f.request({ action: "page", previewId: diff.previewId, offset: diff.nextOffset }), { code: "denied" });
});

test("external session files are exact, read-only targets with current permissions and exclusions", async (t) => {
  const f = await fixture(t);
  const other = await realpath(await mkdtemp(join(tmpdir(), "weft-session-external-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  const path = join(other, "report.md"), untouched = join(other, "untouched.md");
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Workspace", path: f.root },
    { name: "External", path: other }] }, { baseDir: f.configBaseDir });
  await writeFile(path, "outside\n".repeat(1000));
  await writeFile(untouched, "never shared");
  f.events.push({ type: "tool.execution_complete", data: { success: true, toolCallId: "external",
    fileEdits: [{ path, kind: "create" }] } });
  const listing = await f.request({ action: "list", scope: "touched", path: "" });
  assert.deepEqual(listing.entries, [{ path, name: "report.md", kind: "file", access: "written", external: true }]);
  assert.doesNotMatch(JSON.stringify(listing), /untouched|outside\n/);
  const opened = await f.request({ action: "open", path });
  assert.equal(opened.path, path);
  assert.match(opened.text, /^outside\n/);
  assert.equal(f.approvals.at(-1).path, path);
  await assert.rejects(f.request({ action: "open", path: untouched }), { code: "denied" });
  await assert.rejects(f.request({ action: "list", path: other }), { code: "denied" });
  assert.deepEqual((await f.request({ action: "list", scope: "workspace", path: "" })).entries, []);
  await assert.rejects(f.request({ action: "open", path, format: "diff", base: "a".repeat(40) }), { code: "unsupported" });
  f.excluded.add(path);
  await assert.rejects(f.request({ action: "page", previewId: opened.previewId, offset: opened.nextOffset }), { code: "denied" });
  f.excluded.delete(path); f.denied.add(path);
  assert.deepEqual((await f.request({ action: "list", scope: "touched", path: "" })).entries, []);
  await assert.rejects(f.request({ action: "open", path }), { code: "denied" });
});

test("Changes ignores files never touched by this session even if their Git state changed", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await f.file("owned.txt", "old\n");
  await writeFile(join(f.root, "other.txt"), "old\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await f.file("owned.txt", "new\n");
  await writeFile(join(f.root, "other.txt"), "private\n");
  const changes = await f.request({ action: "changes" });
  assert.deepEqual(changes.entries.map((entry) => entry.path), ["owned.txt"]);
  const checks = f.checked.length, approvals = f.approvals.length;
  await assert.rejects(f.request({ action: "open", path: "other.txt", format: "diff", base: changes.base }), { code: "denied" });
  assert.equal(f.checked.length, checks);
  assert.equal(f.approvals.length, approvals);
});

test("a successful directory view never authorizes its children or a directory-wide Git diff", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await mkdir(join(f.root, "folder"));
  await writeFile(join(f.root, "folder", "unread.txt"), "old\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await writeFile(join(f.root, "folder", "unread.txt"), "never exposed\n");
  f.events.push(
    { type: "tool.execution_start", data: { toolCallId: "directory", toolName: "view", arguments: { path: join(f.root, "folder") } } },
    { type: "tool.execution_complete", data: { toolCallId: "directory", success: true } },
  );
  const changes = await f.request({ action: "changes" });
  assert.deepEqual(changes.entries, []);
  await assert.rejects(f.request({ action: "open", path: "folder", format: "diff", base: changes.base }), { code: "unsupported" });
  await assert.rejects(f.request({ action: "open", path: "folder/unread.txt", format: "diff", base: changes.base }), { code: "denied" });
  assert.equal((await f.request({ action: "open", path: "folder/unread.txt" })).text, "never exposed\n");
  await rm(join(f.root, "folder"), { recursive: true });
  assert.deepEqual((await f.request({ action: "changes" })).entries, []);
});

test("current-folder browsing does not read session history and rechecks policy for unopened files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "untouched.txt"), "current folder only");
  f.session.rpc.eventLog.read = async () => { throw new Error("History unavailable"); };
  const current = await f.request({ action: "list", scope: "workspace", path: "" });
  assert.deepEqual(current.entries.map((entry) => entry.path), ["untouched.txt"]);
  assert.equal((await f.request({ action: "open", path: "untouched.txt" })).text, "current folder only");
  f.excluded.add(join(f.root, "untouched.txt"));
  await assert.rejects(f.request({ action: "open", path: "untouched.txt" }), { code: "denied" });
  assert.deepEqual((await f.request({ action: "list", scope: "workspace", path: "" })).entries, []);
  await assert.rejects(f.request({ action: "list", scope: "touched", path: "" }), { code: "unavailable" });
});

test("central file-sharing policy applies to both trees, diff requests and retained preview pages", async (t) => {
  const f = await fixture(t);
  await f.file("visible.md", "content\n".repeat(1000));
  await f.file("private/hidden.md", "private");
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Workspace", path: f.root }],
    exclude: ["private/**"] }, { baseDir: f.configBaseDir });
  for (const scope of ["workspace", "touched"]) {
    const listing = await f.request({ action: "list", scope, path: "" });
    assert.equal(listing.entries.some((entry) => entry.path.startsWith("private")), false);
  }
  await assert.rejects(f.request({ action: "open", path: "private/hidden.md" }), { code: "denied" });
  const opened = await f.request({ action: "open", path: "visible.md" });
  saveFileSharingConfig({ enabled: true, roots: [{ name: "Workspace", path: f.root }],
    exclude: ["visible.md"] }, { baseDir: f.configBaseDir });
  await assert.rejects(f.request({ action: "page", previewId: opened.previewId, offset: opened.nextOffset }), { code: "denied" });
  saveFileSharingConfig({ enabled: false, roots: [] }, { baseDir: f.configBaseDir });
  const checks = f.checked.length;
  await assert.rejects(f.view.checkAvailable(), { code: "denied" });
  await assert.rejects(f.request({ action: "list", path: "" }), { code: "denied" });
  await assert.rejects(f.request({ action: "changes" }), { code: "denied" });
  assert.equal(f.checked.length, checks);
});

test("one central Git-root grant covers a session running in its registered worktree", async (t) => {
  const f = await fixture(t);
  f.git("init", "--quiet");
  await f.file("report.md", "base\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  const container = await realpath(await mkdtemp(join(tmpdir(), "weft-worktree-session-")));
  const linked = join(container, "linked");
  f.git("worktree", "add", "--quiet", "--detach", linked);
  t.after(() => rm(container, { recursive: true, force: true }));
  f.primary(linked);
  const session = f.session;
  let view;
  view = await createWorkspaceView({ session, configBaseDir: f.configBaseDir, requestPermission: (args) => view.grant(args) });
  t.after(() => view.close());
  const result = await view.handle({ requestId: "worktree-open", action: "open", path: "report.md" });
  assert.equal(result.text, await readFile(join(linked, "report.md"), "utf8"));
});
