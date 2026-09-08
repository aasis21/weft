import { describe, expect, it } from 'vitest';
import {
  SecureChannel, deriveSessionKey, generateKeyPair, terminalSnapshot,
  type TerminalSnapshotMsg, type Transport,
} from '@aasis21/weft-shared';
import {
  MAX_TERMINAL_SNAPSHOT_BYTES, terminalSnapshotPayloadBytes,
} from '@/session/runtime/terminalController';
import { boundDemoSnapshot } from '@/lib/demoStation';

function snapshot(data = ''): TerminalSnapshotMsg {
  return { terminalId: 't'.repeat(128), seq: Number.MAX_SAFE_INTEGER, data, cols: 240, rows: 100, truncated: true };
}

describe('relay-safe terminal snapshots', () => {
  it('fits a full-budget escaped snapshot beneath 256 KiB after real v2 AES/base64 and broadcast framing', async () => {
    const message = snapshot();
    const base = terminalSnapshotPayloadBytes(message);
    const group = '\\\x1b' + String.fromCodePoint(0x1f642);
    const groupSize = terminalSnapshotPayloadBytes(snapshot(group)) - base;
    const available = MAX_TERMINAL_SNAPSHOT_BYTES - base;
    message.data = group.repeat(Math.floor(available / groupSize)) + 'x'.repeat(available % groupSize);
    expect(terminalSnapshotPayloadBytes(message)).toBe(MAX_TERMINAL_SNAPSHOT_BYTES);
    expect(new TextEncoder().encode(message.data).length).toBeLessThan(MAX_TERMINAL_SNAPSHOT_BYTES);

    const frames: number[] = [];
    const transport: Transport = {
      connect: async () => {},
      subscribe: () => () => {},
      close: async () => {},
      publish: async (event, envelope) => {
        frames.push(new TextEncoder().encode(JSON.stringify({
          topic: `realtime:weft:${'c'.repeat(128)}`, event: 'broadcast', ref: '12345', join_ref: '12345',
          payload: { type: 'broadcast', event, payload: envelope },
        })).length);
      },
    };
    const laptop = await generateKeyPair();
    const phone = await generateKeyPair();
    const channel = new SecureChannel({
      transport, key: await deriveSessionKey(laptop.privateKey, phone.publicKeyB64), protocolVersion: 2,
      identity: { channelId: 'c'.repeat(128), sessionId: 's'.repeat(128), senderId: 'l'.repeat(128), senderName: 'n'.repeat(256) },
    });
    await channel.connect();
    await channel.send(terminalSnapshot(message));
    await channel.close();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBeGreaterThan(MAX_TERMINAL_SNAPSHOT_BYTES);
    expect(frames[0]).toBeLessThan(256 * 1024);
  });

  it('trims only complete demo scrollback lines and marks the snapshot truncated', () => {
    const line = '\x1b[32m' + 'x'.repeat(200) + '\x1b[0m';
    const result = boundDemoSnapshot({ ...snapshot(Array(1000).fill(line).join('\r\n')), truncated: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a bounded demo snapshot.');
    expect(result.snapshot.truncated).toBe(true);
    expect(terminalSnapshotPayloadBytes(result.snapshot)).toBeLessThanOrEqual(MAX_TERMINAL_SNAPSHOT_BYTES);
    const lines = result.snapshot.data.split('\r\n');
    expect(lines.length).toBeGreaterThanOrEqual(result.snapshot.rows);
    expect(lines.every((value) => value === line)).toBe(true);
  });

  it('returns an explicit error rather than slicing an oversized current demo screen', () => {
    const line = '\x1b[32m' + '\\'.repeat(2000) + '\x1b[0m';
    const result = boundDemoSnapshot(snapshot(Array(100).fill(line).join('\r\n')));
    expect(result).toEqual({
      ok: false,
      error: 'The demo terminal screen exceeds the relay-safe 128 KiB snapshot limit. Close it and open a new demo terminal.',
    });
  });
});
