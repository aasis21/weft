// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile, rename, readdir, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_TYPE, SUBTYPE } from "@aasis21/weft-shared";
import { weftHome } from "./projects.mjs";

// Session stream store
// --------------------
// For every Copilot session shared with the phone, the laptop keeps the session's `stream` events
// (EVENT_TYPE.STREAM) exactly as they were sent live: user and assistant messages, tool cards with
// their real arguments and output, and warnings or errors. When the phone was away (another chat
// open, app in the background, offline), it asks for everything after the last event it saw and
// shows it with the same detail as if it had watched ("catch-up" in the app).
// Streaming fragments, "what I'm doing" hints and busy/idle signals are not kept: the final message
// and the live session state replace them. Approvals and forms come from live session state too.
//
// What is kept, and what goes first when a session outgrows its budget:
//   - events older than three days are removed;
//   - beyond 2,000 events or 10 MiB, the oldest tool cards are removed first (with their matching
//     start/finish card), so the conversation itself stays available the longest. The newest 200
//     events are never thinned;
//   - only when no older tool card is left do the oldest messages go. Losing a message is reported
//     to the phone as "some earlier activity is no longer available"; thinned tool cards are not.
// Which sessions are kept: only sessions shared with the phone have a store. A store nobody has
// written to for three days is removed, and above 100 MiB for the whole laptop the least recently
// active sessions are removed first. This cleanup runs when a session's store is opened, not on
// every event.
//
// On disk each session is one append-only JSON Lines file: a header line (epoch, highest sequence,
// highest lost-message sequence), then one line per event. Each event is appended once; the file is
// rewritten only when more than half of it belongs to removed events. Sequences are what the phone
// uses as its read position, so an event is appended before it is sent and numbers are never reused.

export const STREAM_STORE_DIRECTORY_NAME = "session-streams";
// Folder used by Weft 0.2.49 and earlier for whole-file catch-up caches; removed on open.
const LEGACY_RECOVERY_DIRECTORY_NAME = "recovery";
const FORMAT_VERSION = 1;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SESSION_EVENTS = 2000;
const MAX_SESSION_BYTES = 10 * 1024 * 1024;
const MACHINE_BYTES = 100 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const PAGE_BYTES = 128 * 1024;
const RECENT_EVENTS_NEVER_THINNED = 200;
// Rewrite the file once removed events take up more than this and more than the kept events.
const MINIMUM_REMOVED_BYTES_BEFORE_REWRITE = 1024 * 1024;
const TRUNCATION_MARKER = "\n[Message truncated in catch-up]";

const byteLength = (text) => Buffer.byteLength(text);

function isConversationMessage(message) {
  return message.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE || message.eventSubtype === SUBTYPE.STREAM.ASSISTANT_MESSAGE;
}

function isToolCard(message) {
  return message.eventSubtype === SUBTYPE.STREAM.TOOL_START || message.eventSubtype === SUBTYPE.STREAM.TOOL_COMPLETE;
}

/** The events worth showing a returning phone, exactly as they were sent live. */
function isWorthKeeping(message) {
  if (message?.eventType !== EVENT_TYPE.STREAM || !message.msg || typeof message.msg !== "object") return false;
  if (isConversationMessage(message) || isToolCard(message)) return true;
  return message.eventSubtype === SUBTYPE.STREAM.LOG && ["warn", "warning", "error"].includes(message.msg.level);
}

function clipLongStrings(value, limitBytes) {
  if (typeof value === "string") {
    return byteLength(value) > limitBytes
      ? Buffer.from(value).subarray(0, limitBytes).toString("utf8") + TRUNCATION_MARKER : value;
  }
  if (Array.isArray(value)) return value.map((item) => clipLongStrings(item, limitBytes));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipLongStrings(item, limitBytes)]));
  }
  return value;
}

/** Keep one event within the per-event budget by shortening its longest text, never its identity. */
function withinEventBudget(message, maxEventBytes) {
  if (byteLength(JSON.stringify(message)) <= maxEventBytes) return message;
  for (let limitBytes = Math.floor(maxEventBytes / 2); limitBytes >= 256; limitBytes = Math.floor(limitBytes / 2)) {
    const shortened = { ...message, msg: clipLongStrings(message.msg, limitBytes) };
    if (byteLength(JSON.stringify(shortened)) <= maxEventBytes) return shortened;
  }
  const { toolCallId, toolName, success, messageId, id, origin, level } = message.msg;
  const identity = Object.fromEntries(Object.entries({ toolCallId, toolName, success, messageId, id, origin, level })
    .filter(([, value]) => value !== undefined));
  return { ...message, msg: { ...identity, ...(message.eventSubtype === SUBTYPE.STREAM.TOOL_START ? { args: {} } : {}),
    ...(message.eventSubtype === SUBTYPE.STREAM.TOOL_COMPLETE ? { resultPreview: TRUNCATION_MARKER.trim() } : {}),
    ...(isConversationMessage(message) ? { [message.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE ? "text" : "content"]: TRUNCATION_MARKER.trim() } : {}),
    ...(message.eventSubtype === SUBTYPE.STREAM.LOG ? { message: TRUNCATION_MARKER.trim() } : {}) } };
}

const eventLine = (entry) => JSON.stringify({ kind: "event", sequence: entry.sequence, message: entry.message }) + "\n";

async function removeQuietly(path) {
  try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

/**
 * Open (or create) the stream store of one shared session. `persist: false` keeps it in memory only,
 * used when `~/.weft` cannot be written so live pairing still works.
 */
export async function createSessionStreamStore({
  sessionId, baseDir = weftHome(), persist = true, now = Date.now,
  maxSessionEvents = MAX_SESSION_EVENTS, maxSessionBytes = MAX_SESSION_BYTES, retentionMs = RETENTION_MS,
  machineBytes = MACHINE_BYTES, pageBytes = PAGE_BYTES, maxEventBytes = MAX_EVENT_BYTES,
  recentEventsNeverThinned = RECENT_EVENTS_NEVER_THINNED,
  onIssue = () => console.warn("Weft catch-up cache was reset; older missed events may be unavailable."),
} = {}) {
  const directory = join(baseDir, STREAM_STORE_DIRECTORY_NAME);
  const sessionKey = createHash("sha256").update(String(sessionId)).digest("hex");
  const storePath = join(directory, `${sessionKey}.jsonl`);

  let epoch = randomUUID();
  let highestSequence = 0;
  // Highest sequence of a removed conversation message or warning: a phone behind it missed something.
  let lostThroughSequence = 0;
  /** @type {{ sequence: number, message: object, bytes: number }[]} */
  let entries = [];
  let keptBytes = 0;
  let fileBytes = 0;
  let savedStoreWasUnreadable = false;
  let writeChain = Promise.resolve();

  function remove(index) {
    const [removed] = entries.splice(index, 1);
    keptBytes -= removed.bytes;
    if (!isToolCard(removed.message)) lostThroughSequence = Math.max(lostThroughSequence, removed.sequence);
  }

  function removeExpiredAndExcessEvents() {
    const oldestKeptTimestamp = now() - retentionMs;
    while (entries.length && entries[0].message.ts < oldestKeptTimestamp) remove(0);
    while (entries.length > maxSessionEvents || keptBytes > maxSessionBytes) {
      const thinnableCount = entries.length - recentEventsNeverThinned;
      const oldestToolCard = entries.findIndex((entry, index) => index < thinnableCount && isToolCard(entry.message));
      if (oldestToolCard < 0) { remove(0); continue; }
      const { toolCallId } = entries[oldestToolCard].message.msg;
      for (let index = thinnableCount - 1; index >= oldestToolCard; index--) {
        const entry = entries[index];
        if (index === oldestToolCard || (toolCallId && isToolCard(entry.message) && entry.message.msg.toolCallId === toolCallId)) remove(index);
      }
    }
  }

  function keep(sequence, message) {
    const entry = { sequence, message, bytes: 0 };
    entry.bytes = byteLength(eventLine(entry));
    entries.push(entry);
    keptBytes += entry.bytes;
    return entry;
  }

  async function rewriteFile() {
    const header = JSON.stringify({ kind: "header", version: FORMAT_VERSION, epoch, highestSequence, lostThroughSequence }) + "\n";
    const contents = header + entries.map(eventLine).join("");
    const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { mode: 0o600 });
      await rename(temporaryPath, storePath);
    } catch (error) {
      await removeQuietly(temporaryPath);
      throw new Error("Session catch-up could not be saved.", { cause: error });
    }
    fileBytes = byteLength(contents);
  }

  const removedBytesOnDisk = () => fileBytes - keptBytes;
  const shouldRewrite = () => removedBytesOnDisk() > Math.max(MINIMUM_REMOVED_BYTES_BEFORE_REWRITE, keptBytes);

  /** Returns true when a saved store was loaded and can be appended to as is. */
  async function loadSavedStore() {
    let text;
    try { text = await readFile(storePath, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return false;
      throw new Error("Session stream store could not be loaded.", { cause: error });
    }
    const lines = text.split("\n");
    // A crash during an append leaves an incomplete last line. That event was never sent.
    const interruptedAppend = lines.pop() !== "";
    try {
      const header = JSON.parse(lines[0]);
      if (header?.kind !== "header" || header.version !== FORMAT_VERSION || typeof header.epoch !== "string" ||
          ![header.highestSequence, header.lostThroughSequence].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Invalid session stream store header.");
      }
      const loaded = [];
      for (const line of lines.slice(1)) {
        const record = JSON.parse(line);
        if (record?.kind !== "event" || !Number.isSafeInteger(record.sequence) ||
            record.sequence <= (loaded.at(-1)?.sequence ?? 0) || !Number.isFinite(record.message?.ts) || !isWorthKeeping(record.message)) {
          throw new Error("Invalid session stream store event.");
        }
        loaded.push(record);
      }
      epoch = header.epoch;
      lostThroughSequence = header.lostThroughSequence;
      for (const record of loaded) keep(record.sequence, record.message);
      highestSequence = Math.max(header.highestSequence, entries.at(-1)?.sequence ?? 0);
      fileBytes = byteLength(text);
      return !interruptedAppend;
    } catch (error) {
      entries = [];
      keptBytes = 0;
      savedStoreWasUnreadable = true;
      onIssue(error);
      return false;
    }
  }

  /** Remove stores of sessions idle beyond retention, then the least recently active ones over the budget. */
  async function removeInactiveSessionStores() {
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const otherFiles = (await Promise.all(names
      .filter((name) => /^[a-f0-9]{64}\.jsonl(?:\.\d+\.[a-f0-9-]{36}\.tmp)?$/.test(name))
      .map(async (name) => {
        const path = join(directory, name);
        try { return { path, temporary: name.endsWith(".tmp"), info: await stat(path) }; }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
      }))).filter((file) => file && file.path !== storePath);
    const otherStores = [];
    for (const file of otherFiles) {
      if (now() - file.info.mtimeMs > retentionMs) await removeQuietly(file.path);
      else if (!file.temporary) otherStores.push(file);
    }
    let totalBytes = otherStores.reduce((sum, file) => sum + file.info.size, 0) + fileBytes;
    for (const file of otherStores.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (totalBytes <= machineBytes) break;
      await removeQuietly(file.path);
      totalBytes -= file.info.size;
    }
  }

  if (persist) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const appendable = await loadSavedStore();
    removeExpiredAndExcessEvents();
    if (!appendable || shouldRewrite()) await rewriteFile();
    await removeInactiveSessionStores();
    // Whole-file caches from Weft 0.2.49 and earlier are not migrated.
    await rm(join(baseDir, LEGACY_RECOVERY_DIRECTORY_NAME), { recursive: true, force: true });
  }

  return {
    get epoch() { return epoch; },
    get cursor() { return highestSequence; },
    /**
     * Number an event and append it before it is sent live. Returns the live message stamped with its
     * catch-up position, or null for events that are not kept (streaming fragments, activity).
     */
    capture(message) {
      if (!isWorthKeeping(message)) return Promise.resolve(null);
      const operation = writeChain.then(async () => {
        const sequence = highestSequence + 1;
        const stored = withinEventBudget(
          { ...message, ts: message.ts ?? now() }, maxEventBytes);
        const line = eventLine({ sequence, message: stored });
        if (persist) {
          try { await appendFile(storePath, line, { mode: 0o600 }); }
          catch (error) { throw new Error("Session catch-up could not be saved.", { cause: error }); }
          fileBytes += byteLength(line);
        }
        highestSequence = sequence;
        keep(sequence, stored);
        removeExpiredAndExcessEvents();
        if (persist && shouldRewrite()) {
          // A failed rewrite leaves the appended file intact; the next event retries it.
          try { await rewriteFile(); } catch { /* retried on the next event */ }
        }
        return { ...message, streamEpoch: epoch, streamSequence: sequence };
      });
      writeChain = operation.catch(() => {});
      return operation;
    },
    /** Events after the phone's position, oldest first, at most `limit` events and about 128 KiB. */
    async page(requestedEpoch, requestedCursor = 0, limit = 50) {
      await writeChain;
      removeExpiredAndExcessEvents();
      const after = requestedEpoch === epoch && Number.isSafeInteger(requestedCursor) && requestedCursor >= 0 ? requestedCursor : 0;
      const count = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
      const newer = entries.filter((entry) => entry.sequence > after);
      const items = [];
      let bytes = 0;
      for (const entry of newer.slice(0, count)) {
        if (items.length && bytes + entry.bytes > pageBytes) break;
        items.push({ sequence: entry.sequence, message: entry.message });
        bytes += entry.bytes;
      }
      return {
        items, epoch,
        cursor: items.at(-1)?.sequence ?? highestSequence,
        hasMore: newer.length > items.length,
        gap: (savedStoreWasUnreadable && after === 0) || after < lostThroughSequence ||
          Boolean(requestedEpoch && requestedEpoch !== epoch),
      };
    },
    /** Assistant replies after the phone's last viewed position, for the session list's "N new" badge. */
    countUnseenReplies(seenEpoch, seenCursor) {
      const after = seenEpoch === epoch && Number.isSafeInteger(seenCursor) && seenCursor >= 0 ? seenCursor : 0;
      let replies = 0;
      for (let index = entries.length - 1; index >= 0 && entries[index].sequence > after; index--) {
        if (entries[index].message.eventSubtype === SUBTYPE.STREAM.ASSISTANT_MESSAGE) replies++;
      }
      return replies;
    },
    close: () => writeChain,
  };
}