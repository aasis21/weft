// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createWorkspaceView } from "../src/workspaceView.mjs";
import { WORKSPACE_LIMITS } from "@aasis21/weft-shared";

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "weft-workspace-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const excluded = new Set(), denied = new Set(), checked = [], approvals = [];
  let available = true, approve = true, primary = root, time = Date.now();
  const session = { rpc: {
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
    session, clock: () => time,
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
  };
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  return { root, session, view, request, file, git, checked, excluded, denied, approvals,
    policy(value) { available = value; }, approve(value) { approve = value; },
    primary(value) { primary = value; }, tick(value) { time += value; } };
}

test("folder browsing reads one level and excludes forbidden names before sending", async (t) => {
  const f = await fixture(t);
  await f.file("folder/nested.md", "# nested");
  await f.file("root.txt", "not in the listing");
  await f.file(".env", "never shared");
  await f.file(".git/config", "never shared");
  await f.file("restricted.md", "never shared");
  f.excluded.add(join(f.root, "restricted.md"));
  const page = await f.request({ action: "list", path: "" });
  assert.deepEqual(page.entries.map((entry) => entry.name), ["folder", "root.txt"]);
  assert.doesNotMatch(JSON.stringify(page), /not in the listing|nested.md|restricted|never shared/);
  assert.equal(f.approvals.length, 1);
  assert.deepEqual((await f.request({ action: "list", path: "folder" })).entries.map((entry) => entry.name), ["nested.md"]);
});

test("directory pagination is bounded and rejects changed cursors", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 110 }, (_, n) => f.file(`${String(n).padStart(3, "0")}.txt`, "x")));
  const first = await f.request({ action: "list", path: "." });
  assert.equal(first.entries.length, 100);
  const second = await f.request({ action: "list", path: ".", cursor: first.cursor });
  assert.equal(second.entries.length, 10);
  await f.file("new.txt", "new");
  await assert.rejects(f.request({ action: "list", path: ".", cursor: first.cursor }), { code: "changed" });
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
  await f.file("scope/inside.txt", "old\n"); await f.file("outside.txt", "old\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base");
  await f.file("scope/inside.txt", "new\n"); await f.file("outside.txt", "private\n");
  const primary = join(f.root, "scope");
  const session = { rpc: {
    permissions: { paths: { list: async () => ({ primary }), isPathWithinAllowedDirectories: async () => ({ allowed: true }) } },
    contentExclusion: { checkPaths: async ({ paths }) => ({ available: true, checks: paths.map((path) => ({ path, excluded: false })) }) },
  } };
  let view;
  view = await createWorkspaceView({ session, requestPermission: (args) => view.grant(args) });
  t.after(() => view.close());
  const changes = await view.handle({ requestId: "nested", action: "changes" });
  assert.deepEqual(changes.entries.map((entry) => entry.path), ["inside.txt"]);
  const diff = await view.handle({ requestId: "nested-open", action: "open", path: "inside.txt", format: "diff", base: changes.base });
  assert.match(diff.text, /\+new/);
  assert.doesNotMatch(diff.text, /outside|private/);
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
