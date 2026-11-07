// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_TYPE, SUBTYPE, logLine } from "@aasis21/weft-shared";
import { weftHome } from "./projects.mjs";

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 10 * 1024 * 1024;
const MACHINE_BYTES = 100 * 1024 * 1024;

function meaningful(message) {
  if (message.eventType !== EVENT_TYPE.STREAM) return null;
  const subtype = message.eventSubtype;
  if ([SUBTYPE.STREAM.ASSISTANT_MESSAGE, SUBTYPE.STREAM.USER_MESSAGE].includes(subtype)) return message;
  if (subtype === SUBTYPE.STREAM.TOOL_START) {
    return { ...message, msg: { toolCallId: message.msg.toolCallId, toolName: message.msg.toolName, args: {} } };
  }
  if (subtype === SUBTYPE.STREAM.TOOL_COMPLETE) {
    return { ...message, msg: {
      toolCallId: message.msg.toolCallId, toolName: message.msg.toolName,
      success: message.msg.success, resultPreview: message.msg.success ? "Completed" : "Failed",
    } };
  }
  if (subtype === SUBTYPE.STREAM.LOG_LINE && message.msg.level === "error") {
    return { ...message, msg: logLine("error", "Copilot reported an error. Check the local session for details.").msg };
  }
  return null;
}

export async function createSessionRecovery({
  sessionId, baseDir = weftHome(), persist = true, now = Date.now,
  maxBytes = MAX_BYTES, maxEvents = 2000, retentionMs = RETENTION_MS,
  machineBytes = MACHINE_BYTES, pageBytes = 128 * 1024, maxEventBytes = 64 * 1024,
  onIssue = () => console.warn("Weft catch-up cache was reset; older missed events may be unavailable."),
} = {}) {
  const dir = join(baseDir, "recovery");
  const file = join(dir, `${createHash("sha256").update(String(sessionId)).digest("hex")}.json`);
  let record = { epoch: randomUUID(), cursor: 0, entries: [], gapThrough: 0 };
  let gap = false;
  let chain = Promise.resolve();
  if (persist) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (
        typeof saved.epoch !== "string" || !Number.isSafeInteger(saved.cursor) || saved.cursor < 0 ||
        !Array.isArray(saved.entries) || !saved.entries.every((entry, index) =>
          Number.isSafeInteger(entry?.sequence) && entry.sequence > (saved.entries[index - 1]?.sequence ?? 0) &&
          entry.sequence <= saved.cursor && Number.isFinite(entry.message?.ts) && meaningful(entry.message),
        )
      ) {
        const error = new Error("Invalid recovery journal.");
        error.code = "WEFT_RECOVERY_CORRUPT";
        throw error;
      }
      record = { ...saved, gapThrough: Number.isSafeInteger(saved.gapThrough) ? saved.gapThrough : 0 };
    } catch (error) {
      if (error instanceof SyntaxError || error.code === "WEFT_RECOVERY_CORRUPT") {
        gap = true;
        onIssue(error);
      } else if (error.code !== "ENOENT") throw new Error("Session recovery journal could not be loaded.", { cause: error });
    }
    await pruneOtherCaches(maxBytes);
  }
  async function pruneOtherCaches(incomingBytes) {
    const candidates = (await Promise.all((await readdir(dir))
      .filter((name) => /^[a-f0-9]{64}\.json(?:\.\d+\.[a-f0-9-]{36}\.tmp)?$/.test(name))
      .map(async (name) => {
        const path = join(dir, name);
        try { return { path, temporary: name.endsWith(".tmp"), info: await stat(path) }; }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
      }))).filter((item) => item && item.path !== file);
    let bytes = candidates.reduce((sum, item) => sum + item.info.size, 0) + incomingBytes;
    for (const item of candidates.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (item.temporary && now() - item.info.mtimeMs <= retentionMs) continue;
      if (now() - item.info.mtimeMs > retentionMs || bytes > machineBytes) {
        try { await unlink(item.path); bytes -= item.info.size; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  function prune() {
    const before = record.entries;
    record.entries = record.entries.filter((entry) => now() - entry.message.ts <= retentionMs).slice(-maxEvents);
    while (Buffer.byteLength(JSON.stringify(record)) > maxBytes && record.entries.length) record.entries.shift();
    const retained = new Set(record.entries.map((entry) => entry.sequence));
    for (const entry of before) {
      if (!retained.has(entry.sequence)) record.gapThrough = Math.max(record.gapThrough, entry.sequence);
    }
  }
  async function save() {
    if (!persist) return;
    await pruneOtherCaches(Buffer.byteLength(JSON.stringify(record)));
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      try { await unlink(tmp); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
      throw new Error("Session catch-up could not be saved.", { cause: error });
    }
  }
  prune();
  return {
    get epoch() { return record.epoch; },
    get cursor() { return record.cursor; },
    capture(message) {
      const compact = meaningful(message);
      if (!compact) return Promise.resolve(null);
      const operation = chain.then(async () => {
        const stamped = {
          ...compact, ts: compact.ts ?? now(),
          recoveryEpoch: record.epoch, recoverySequence: record.cursor + 1,
        };
        const textField = typeof stamped.msg.content === "string" ? "content" : "text";
        if (Buffer.byteLength(JSON.stringify(stamped)) > maxEventBytes && typeof stamped.msg[textField] === "string") {
          stamped.msg = {
            ...stamped.msg,
            [textField]: Buffer.from(stamped.msg[textField]).subarray(0, Math.floor(maxEventBytes / 2)).toString("utf8") +
              "\n[Message truncated in catch-up]",
          };
          record.gapThrough = record.cursor + 1;
        }
        record.cursor++;
        record.entries.push({ sequence: record.cursor, message: stamped });
        prune();
        await save();
        return { ...message, recoveryEpoch: record.epoch, recoverySequence: record.cursor };
      });
      chain = operation.catch(() => {});
      return operation;
    },
    async page(epoch, cursor = 0, limit = 50) {
      await chain;
      prune();
      const after = epoch === record.epoch && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      const count = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
      const all = record.entries.filter((entry) => entry.sequence > after);
      const entries = [];
      let bytes = 0;
      for (const entry of all.slice(0, count)) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length && bytes + size > pageBytes) break;
        entries.push(entry);
        bytes += size;
      }
      return {
        items: entries, epoch: record.epoch,
        cursor: entries.at(-1)?.sequence ?? record.cursor,
        hasMore: all.length > entries.length,
        gap: (gap && after === 0) || after < record.gapThrough || Boolean(epoch && epoch !== record.epoch) ||
          Boolean(record.entries.length && after < record.entries[0].sequence - 1) || (gap && !record.entries.length),
      };
    },
    close: () => chain,
  };
}
