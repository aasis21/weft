// SPDX-License-Identifier: Apache-2.0
import { lstat, realpath, opendir, open } from "node:fs/promises";
import { resolve, relative, join, isAbsolute, sep, extname, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKSPACE_LIMITS as LIMITS, validWorkspaceRequest } from "@aasis21/weft-shared";

const exec = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (root, path) => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const blocked = (path) => path.split(/[\\/]/).some((part) => {
  const name = process.platform === "win32" ? part.replace(/[. ]+$/, "") : part;
  return [".git", ".ssh", ".weft", ".copilot"].includes(name.toLowerCase()) ||
    /^\.env(?:\.|$)/i.test(name);
});
export class WorkspaceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new WorkspaceError(code, message); };

export async function createWorkspaceView({ session, requestPermission, clock = Date.now } = {}) {
  if (!session?.rpc?.contentExclusion?.checkPaths ||
      !session?.rpc?.permissions?.paths?.isPathWithinAllowedDirectories ||
      !session?.rpc?.permissions?.paths?.list || !requestPermission) {
    fail("unsupported", "Update Copilot: workspace read-policy support is unavailable.");
  }
  const grants = await session.rpc.permissions.paths.list();
  if (!isAbsolute(grants?.primary ?? "")) fail("unavailable", "The session workspace is unavailable.");
  const primary = resolve(grants.primary);
  const root = await realpath(primary);
  if (/^(?:\\\\|\/\/)/.test(root)) fail("denied", "Network workspaces are not supported.");
  const previews = new Map();
  const pending = new Map();
  let changeList = null;
  let closed = false;
  let busy = false;

  async function check(paths) {
    if (closed) fail("unavailable", "The workspace connection ended.");
    const current = await session.rpc.permissions.paths.list();
    if (!isAbsolute(current?.primary ?? "")) fail("unavailable", "The session workspace is unavailable.");
    if (!same(resolve(current.primary ?? ""), primary) || !same(await realpath(primary), root)) {
      fail("changed", "The session workspace changed. Reconnect before browsing.");
    }
    const allowedPaths = [];
    for (const path of paths) {
      if (!within(root, path) || blocked(relative(root, path))) fail("denied", "The requested path is not available.");
      const result = await session.rpc.permissions.paths.isPathWithinAllowedDirectories({ path });
      if (typeof result?.allowed !== "boolean") fail("unavailable", "Copilot read-policy support is unavailable.");
      allowedPaths.push(result.allowed);
    }
    const result = await session.rpc.contentExclusion.checkPaths({ paths });
    if (result?.available !== true || result.checks?.length !== paths.length) {
      fail("unavailable", "Copilot content-exclusion policy is unavailable. No files were read.");
    }
    return paths.map((path, i) => {
      if (!same(path, result.checks[i]?.path ?? "")) fail("unavailable", "Copilot returned an incomplete read-policy result.");
      return result.checks[i].excluded === false && allowedPaths[i];
    });
  }
  async function pathFor(input, deleted = false) {
    if (process.platform === "win32" && input.replace(/^[a-z]:/i, "").includes(":")) {
      fail("denied", "Alternate file streams are not supported.");
    }
    if (/^(?:\\\\|\/\/)/.test(input) || /^[a-z]+:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
      fail("denied", "Only paths inside this session workspace can be opened.");
    }
    const segments = input.split(/[\\/]/);
    if (segments.includes("..")) fail("denied", "The requested path is not available.");
    const path = isAbsolute(input) ? resolve(input) : resolve(root, input.replace(/[\\/]/g, sep));
    if (!within(root, path)) fail("denied", "Only paths inside this session workspace can be opened.");
    if (!(await check([path]))[0]) fail("denied", "This path is denied or excluded by Copilot policy.");
    const parts = relative(root, path).split(sep).filter(Boolean);
    let walked = root;
    for (let i = 0; i < parts.length; i++) {
      walked = join(walked, parts[i]);
      try {
        const info = await lstat(walked);
        if (info.isSymbolicLink()) fail("denied", "Symbolic links are not supported in workspace previews.");
      } catch (error) {
        if (deleted && error.code === "ENOENT") return path;
        throw error;
      }
    }
    const canonical = await realpath(deleted ? join(path, "..") : path);
    if (!withinRootAllowed(canonical)) fail("denied", "The requested path left the session workspace.");
    return path;
  }
  function withinRootAllowed(path) { return within(root, path) && !blocked(relative(root, path)); }
  async function authorize(action, path) {
    const id = randomUUID();
    const record = { action, path, granted: false };
    pending.set(id, record);
    let timer;
    try {
      await Promise.race([
        requestPermission({ requestId: id, action, path: relative(root, path).split(sep).join("/") || "." }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new WorkspaceError("timeout", "Workspace approval timed out. Retry when ready.")), 55_000);
          timer.unref?.();
        }),
      ]);
      if (!record.granted || closed) fail("denied", "Workspace access was not approved.");
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  async function grant({ requestId, action, path }) {
    const record = pending.get(requestId);
    if (!record || record.action !== action ||
        path !== (relative(root, record.path).split(sep).join("/") || ".")) {
      fail("denied", "This workspace request is no longer pending.");
    }
    if (!(await check([record.path]))[0]) fail("denied", "This path is excluded by Copilot policy.");
    record.granted = true;
    return "Workspace read authorized. No file content is included in this tool result.";
  }
  async function git(args, maxBuffer = LIMITS.htmlBytes) {
    try {
      const result = await exec("git", [
        "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false",
        "-c", "diff.external=", "-C", root, ...args,
      ], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        timeout: 10000, maxBuffer, windowsHide: true, encoding: "buffer" });
      try { return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
      catch { fail("unsupported", "Non-UTF-8 Git output cannot be previewed."); }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("too-large", "Git output exceeds the preview limit.");
      fail("unavailable", "Git comparison is unavailable in this workspace.");
    }
  }
  function prune() {
    for (const [id, value] of previews) if (clock() - value.capturedAt >= LIMITS.ttlMs) {
      clearTimeout(value.timer); previews.delete(id);
    }
  }
  function page(snapshot, offset) {
    let text = "", index = offset, count = 0;
    if (offset > snapshot.text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(snapshot.text[offset] ?? "")) {
      fail("invalid-request", "Invalid preview offset.");
    }
    while (index < snapshot.text.length && count < LIMITS.pageLines) {
      const point = String.fromCodePoint(snapshot.text.codePointAt(index));
      if (Buffer.byteLength(JSON.stringify(text + point)) > LIMITS.pageBytes) break;
      text += point; index += point.length;
      if (point === "\n") count++;
    }
    return { action: "page", previewId: snapshot.id, revision: snapshot.revision,
      text, offset, nextOffset: index < snapshot.text.length ? index : null };
  }
  async function list(input) {
    const path = await pathFor(input.path);
    if (!(await lstat(path)).isDirectory()) fail("invalid-request", "Select a directory.");
    await authorize("list", path);
    const names = [];
    let seen = 0;
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++seen > LIMITS.directoryEntries) fail("too-large", "This directory has too many entries. Choose a narrower folder.");
      if (!blocked(entry.name) && !/[\0\r\n]/.test(entry.name) && (entry.isDirectory() || entry.isFile()) && entry.name.length <= 255) {
        names.push({ name: entry.name, kind: entry.isDirectory() ? "folder" : "file",
          path: relative(root, join(path, entry.name)).split(sep).join("/") });
      }
    }
    await pathFor(input.path);
    names.sort((a, b) => (b.kind === "folder") - (a.kind === "folder") || a.name.localeCompare(b.name));
    const stamp = hash(JSON.stringify(names)).slice(0, 16);
    const [previous, position] = (input.cursor ?? `${stamp}:0`).split(":");
    if (previous !== stamp || !/^\d+$/.test(position ?? "")) fail("changed", "The folder changed. Refresh its listing.");
    const start = Number(position);
    if (!Number.isSafeInteger(start) || start > names.length) fail("invalid-request", "Invalid folder cursor.");
    const candidates = [];
    for (const entry of names.slice(start, start + LIMITS.entries)) {
      if (Buffer.byteLength(JSON.stringify([...candidates, entry])) > LIMITS.pageBytes) break;
      candidates.push(entry);
    }
    const allowed = await check(candidates.map((entry) => join(root, entry.path)));
    return { action: "list", path: relative(root, path).split(sep).join("/"),
      entries: candidates.filter((_, i) => allowed[i]),
      cursor: start + candidates.length < names.length ? `${stamp}:${start + candidates.length}` : null };
  }
  async function changes(input) {
    await pathFor(".");
    await authorize("changes", root);
    if (!input.cursor) {
      const base = (await git(["rev-parse", "--verify", "HEAD"])).trim();
      if (!/^[a-f0-9]{40,64}$/.test(base)) fail("unavailable", "This repository has no HEAD commit.");
      const tracked = new Set([
        ...(await git(["ls-files", "--cached", "-z", "--", "."])).split("\0"),
        ...(await git(["ls-tree", "-r", "--name-only", "-z", base, "--", "."])).split("\0"),
      ].filter((path) => path && !blocked(path) && !/[\0\r\n]/.test(path)));
      if (tracked.size > LIMITS.directoryEntries) fail("too-large", "Too many workspace files. Choose a narrower workspace for Changes.");
      const readable = [];
      const candidates = [...tracked];
      for (let i = 0; i < candidates.length; i += LIMITS.entries) {
        const batch = candidates.slice(i, i + LIMITS.entries);
        const allowed = await check(batch.map((path) => join(root, path)));
        for (let n = 0; n < batch.length; n++) {
          if (!allowed[n]) continue;
          try { await pathFor(batch[n], true); readable.push(batch[n]); }
          catch (error) { if (error.code !== "denied" && error.code !== "missing" && error.code !== "ENOENT") throw error; }
        }
      }
      if (Buffer.byteLength(readable.join("\0")) > 24000) fail("too-large", "This workspace is too broad for Changes. Choose a narrower workspace.");
      const raw = readable.length
        ? (await git(["diff", "--relative", "--no-ext-diff", "--no-textconv", "--name-status", "-z", base, "--", ...readable])).split("\0")
        : [];
      const entries = [];
      for (let i = 0; i < raw.length && raw[i];) {
        const status = raw[i++], first = raw[i++], renamed = /^[RC]/.test(status);
        const path = renamed ? raw[i++] : first;
        const absolute = join(root, path);
        if (within(root, absolute) && !blocked(path) && !/[\0\r\n]/.test(path)) entries.push({ path, name: basename(path),
          kind: "file", status: status[0], ...(renamed ? { oldPath: first } : {}) });
      }
      for (const path of (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])).split("\0").filter(Boolean)) {
        if (!blocked(path) && !/[\0\r\n]/.test(path)) entries.push({ path, name: basename(path), kind: "file", status: "?" });
      }
      if (entries.length > LIMITS.directoryEntries) fail("too-large", "Too many changed files. Use a narrower workspace.");
      changeList = { id: randomUUID(), entries, base, at: clock() };
    }
    if (!changeList || clock() - changeList.at >= LIMITS.ttlMs) fail("expired", "The changes list expired. Refresh.");
    const [id, offset] = (input.cursor ?? `${changeList.id}:0`).split(":");
    if (id !== changeList.id || !/^\d+$/.test(offset ?? "")) fail("changed", "The changes listing changed. Refresh.");
    const start = Number(offset), items = [];
    if (!Number.isSafeInteger(start) || start > changeList.entries.length) fail("invalid-request", "Invalid changes cursor.");
    for (const entry of changeList.entries.slice(start, start + LIMITS.entries)) {
      if (Buffer.byteLength(JSON.stringify([...items, entry])) > LIMITS.pageBytes) break;
      items.push(entry);
    }
    const permissions = await check(items.flatMap((entry) => [join(root, entry.path), ...(entry.oldPath ? [join(root, entry.oldPath)] : [])]));
    let index = 0;
    const entries = items.filter((entry) => {
      const allowed = permissions[index++];
      return entry.oldPath ? permissions[index++] && allowed : allowed;
    });
    return { action: "changes", entries, base: changeList.base,
      cursor: start + items.length < changeList.entries.length ? `${id}:${start + items.length}` : null };
  }
  async function capture(input) {
    prune();
    if (previews.size >= LIMITS.previews) fail("too-large", "Close a preview before opening another.");
    const diff = input.format === "diff", path = await pathFor(input.path, diff);
    if (!diff && /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|docx|xlsx|pptx|exe|dll|wasm|mp[34])$/i.test(path)) {
      fail("unsupported", "This file type does not have a text preview.");
    }
    const authorizedPaths = [path];
    await authorize(diff ? "diff" : "open", path);
    let text, format, base = null;
    if (diff) {
      base = input.base;
      if (!base) fail("invalid-request", "Refresh Changes before opening a diff.");
      if ((await git(["rev-parse", "--verify", base + "^{commit}"])).trim() !== base) fail("changed", "The diff baseline is unavailable. Refresh Changes.");
      const renamed = changeList?.base === base && changeList.entries.find((entry) =>
        join(root, entry.path) === path && entry.oldPath);
      if (renamed) authorizedPaths.push(await pathFor(renamed.oldPath, true));
      const stamps = await Promise.all(authorizedPaths.map(fileStamp));
      text = await git(["diff", "--relative", "--no-ext-diff", "--no-textconv", renamed ? "--find-renames" : "--no-renames", "--unified=3", base, "--",
        relative(root, path), ...(renamed ? [renamed.oldPath] : [])]);
      const currentStamps = await Promise.all(authorizedPaths.map(fileStamp));
      if (JSON.stringify(stamps) !== JSON.stringify(currentStamps)) fail("changed", "The working file changed during comparison. Retry.");
      if (/^Binary files |^GIT binary patch/m.test(text)) fail("unsupported", "Binary changes cannot be rendered as a text diff.");
      format = "diff";
    } else {
      const file = await open(path, "r");
      try {
        const before = await file.stat();
        const named = await lstat(path);
        await pathFor(input.path);
        if (named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) {
          fail("changed", "The file changed before it could be read.");
        }
        if (!before.isFile()) fail("unsupported", "Only regular files can be previewed.");
        const extension = extname(path).toLowerCase();
        format = [".md", ".markdown"].includes(extension) ? "markdown" : [".html", ".htm"].includes(extension) ? "html" : "source";
        const limit = format === "html" ? LIMITS.htmlBytes : LIMITS.fileBytes;
        if (before.size > limit) fail("too-large", "This file exceeds the preview size limit.");
        const buffer = Buffer.alloc(limit + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
        }
        if (bytes > limit) fail("too-large", "This file exceeds the preview size limit.");
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); }
        catch { fail("unsupported", "Binary or non-UTF-8 files cannot be previewed."); }
        if (text.includes("\0")) fail("unsupported", "Binary files cannot be previewed.");
        const after = await file.stat(), current = await lstat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            current.ino !== after.ino || current.isSymbolicLink()) fail("changed", "The file changed while it was read. Retry.");
      } finally { await file.close(); }
    }
    await pathFor(input.path, diff);
    for (const authorized of authorizedPaths.slice(1)) await pathFor(relative(root, authorized), true);
    const totalLines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    if (totalLines > LIMITS.lines) fail("too-large", "This file exceeds the preview line limit.");
    const snapshot = { id: randomUUID(), text, path, authorizedPaths, revision: hash(text), capturedAt: clock() };
    snapshot.timer = setTimeout(() => previews.delete(snapshot.id), LIMITS.ttlMs);
    snapshot.timer.unref?.();
    previews.set(snapshot.id, snapshot);
    return { ...page(snapshot, 0), action: "open", path: relative(root, path).split(sep).join("/"),
      format, capturedAt: snapshot.capturedAt, totalLines, base };
  }
  async function fileStamp(path) {
    try {
      const info = await lstat(path);
      return { size: info.size, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function handle(input) {
    if (!validWorkspaceRequest(input)) fail("invalid-request", "Invalid workspace request.");
    if (input.action === "close") {
      clearTimeout(previews.get(input.previewId)?.timer);
      previews.delete(input.previewId);
      return { action: "close" };
    }
    if (closed) fail("unavailable", "The workspace connection ended.");
    if (busy) fail("busy", "Another workspace request is in progress.");
    busy = true;
    try {
      if (input.action === "list") return await list(input);
      if (input.action === "changes") return await changes(input);
      if (input.action === "open") return await capture(input);
      prune();
      const snapshot = previews.get(input.previewId);
      if (!snapshot) fail("expired", "This preview expired. Refresh to load it again.");
      for (const path of snapshot.authorizedPaths) await pathFor(relative(root, path), true);
      return page(snapshot, input.offset);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error.code === "ENOENT") fail("missing", "The requested file or directory no longer exists.");
      fail("unavailable", "The workspace could not be read.");
    } finally { busy = false; }
  }
  return { handle, grant, close() {
    closed = true;
    for (const snapshot of previews.values()) clearTimeout(snapshot.timer);
    previews.clear(); pending.clear(); changeList = null;
  } };
}
