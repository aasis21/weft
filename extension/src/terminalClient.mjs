// SPDX-License-Identifier: Apache-2.0
import { connect } from "node:net";
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { SUBTYPE } from "@aasis21/weft-shared";
import { TERMINAL_LIMITS } from "./terminalHost.mjs";

export function localTerminalDimensions(output) {
  return {
    cols: Math.max(20, Math.min(240, output.columns || 80)),
    rows: Math.max(5, Math.min(100, output.rows || 24)),
  };
}

// These are terminal-emulator responses, not a human's attempt to take control.
export function isTerminalReply(data) {
  return /^(?:\x1b\[(?:\??[0-9;]*[cnR]|\>[0-9;]*c)|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data);
}

export async function attachTerminal({
  env = process.env, input = process.stdin, output = process.stdout, openConsole = true,
} = {}) {
  const pipe = env.WEFT_TERMINAL_PIPE, token = env.WEFT_TERMINAL_TOKEN, terminalId = env.WEFT_TERMINAL_ID;
  for (const key of Object.keys(env)) if (key.startsWith("WEFT_TERMINAL_")) delete env[key];
  if (!/^\\\\\.\\pipe\\weft-terminal-\d+-[0-9a-f-]+$/.test(pipe ?? "") ||
      !/^[0-9a-f]{64}$/.test(token ?? "") || !/^[0-9a-f-]{36}$/.test(terminalId ?? "")) {
    throw new Error("Run Open terminal from the paired phone. The laptop attach client requires a private Station handoff.");
  }
  let ownInput = false, ownOutput = false;
  if ((!input.isTTY || !output.isTTY) && openConsole && process.platform === "win32") {
    try {
      if (!input.isTTY) { input = new ReadStream(openSync("CONIN$", "r")); ownInput = true; }
      if (!output.isTTY) { output = new WriteStream(openSync("CONOUT$", "w")); ownOutput = true; }
    } catch {
      if (ownInput) input.destroy();
      throw new Error("The visible terminal has no usable Windows console.");
    }
  }
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("The attach client must run in an interactive laptop console.");
  }
  const socket = connect(pipe);
  let buffer = "", owner = "phone", seq = null, closed = false, pendingEscape = "", escapeTimer = null;
  let applyingSnapshot = false;
  const oldRaw = input.isRaw;
  const write = (message) => {
    if (!socket.destroyed && socket.writableLength <= TERMINAL_LIMITS.socketBytes) socket.write(`${JSON.stringify(message)}\n`);
    else socket.destroy();
  };
  const resize = () => {
    if (owner === "laptop" && !applyingSnapshot) write({ type: "resize", ...localTerminalDimensions(output) });
  };
  const sendInput = (data) => {
    const reply = isTerminalReply(data);
    if (reply && owner !== "laptop") return;
    // Native paste can exceed a protocol frame. Split without breaking surrogate pairs.
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 2048, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      write({ type: "input", data: data.slice(offset, end), claim: !reply, ...localTerminalDimensions(output) });
      offset = end;
    }
  };
  const onInput = (chunk) => {
    pendingEscape += chunk.toString();
    clearTimeout(escapeTimer);
    if (pendingEscape.startsWith("\x1b") && !isTerminalReply(pendingEscape) &&
        /^(?:\x1b|\x1b\[[?>]?[0-9;]*|\x1b[\]P][^\x07]*)$/.test(pendingEscape)) {
      escapeTimer = setTimeout(() => { const data = pendingEscape; pendingEscape = ""; sendInput(data); }, 40);
      return;
    }
    const data = pendingEscape; pendingEscape = ""; sendInput(data);
  };
  const onSignal = () => socket.destroy();
  try {
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onInput);
    input.on("end", onSignal);
    output.on("resize", resize);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    await new Promise((resolve, reject) => {
      socket.setEncoding("utf8");
      socket.setTimeout(15_000, () => { socket.destroy(); reject(new Error("Station did not complete the local terminal attachment.")); });
      socket.on("connect", () => write({ type: "hello", terminalId, token }));
      socket.on("error", () => reject(new Error("The local Station terminal connection failed.")));
      socket.on("close", () => {
        if (closed) resolve();
        else reject(new Error("The local terminal connection closed."));
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > TERMINAL_LIMITS.socketBytes) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let envelope;
          try { envelope = JSON.parse(line); } catch { socket.destroy(); return; }
          const message = envelope.msg;
          if (message?.terminalId !== terminalId) { socket.destroy(); return; }
          socket.setTimeout(0);
          if (envelope.eventSubtype === SUBTYPE.CONTROL.TERMINAL_STATE) {
            owner = message.owner;
            if (message.status === "open" && (output.columns !== message.cols || output.rows !== message.rows)) {
              applyingSnapshot = true;
              output.write(`\x1b[8;${message.rows};${message.cols}t`, () => { applyingSnapshot = false; });
            }
            if (message.status === "closed") { closed = true; socket.end(); }
          } else if (envelope.eventSubtype === SUBTYPE.CONTROL.TERMINAL_SNAPSHOT) {
            applyingSnapshot = true;
            seq = message.seq;
            output.write(`\x1bc\x1b[8;${message.rows};${message.cols}t${message.data}`, () => { applyingSnapshot = false; });
          } else if (envelope.eventSubtype === SUBTYPE.CONTROL.TERMINAL_OUTPUT && seq !== null) {
            if (message.seq <= seq) continue;
            if (message.seq !== seq + 1) { seq = null; write({ type: "snapshot" }); continue; }
            seq = message.seq;
            if (!output.write(message.data)) {
              socket.pause();
              output.once("drain", () => socket.resume());
            }
          }
        }
      });
    });
  } finally {
    clearTimeout(escapeTimer);
    socket.destroy();
    input.removeListener("data", onInput);
    input.removeListener("end", onSignal);
    output.removeListener("resize", resize);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    input.setRawMode(Boolean(oldRaw));
    input.pause();
    if (ownInput) input.destroy();
    if (ownOutput) output.destroy();
  }
}
