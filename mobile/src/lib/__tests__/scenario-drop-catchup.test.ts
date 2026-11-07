import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';
import {
  ATTENTION_CAPABILITY, WATCH_RENEW_MS, WATCH_COOLDOWN_MS,
  channelUp, stateSnapshot, sessionStatus, recovery, assistantMessage, toolStart, toolComplete,
  approvalRequest, watchRequest, watchState, recoveryRequest, isValidEnvelope,
} from '@aasis21/weft-shared';
import { loadTranscript } from '@/lib/transcripts';
import { preferencesStorage } from '@/services/persistence/preferencesStorage';
import { pairingIdentities } from '@/test/helpers/fakeWeftClient';
import { loadSessions } from '@/lib/sessions';
import { loadDevices } from '@/lib/devices';

describe('scenario: drop catchup', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    h = makeManager();
  });

  it('keeps the additive watch and recovery factories valid envelopes', () => {
    for (const message of [
      watchRequest('visit', 'detail'), watchState('visit', 'off', 0),
      recoveryRequest(), sessionStatus({ busy: true, epoch: 'e', cursor: 2, pendingApprovals: 1, pendingForms: 0 }),
      recovery([{ sequence: 1, message: assistantMessage('done', 'a') }], 'e', 1),
    ]) expect(isValidEnvelope(message)).toBe(true);
    expect(watchRequest('visit', 'compact').msg).toEqual({ watchId: 'visit', level: 'compact', leaseMs: 60_000 });
    expect(recoveryRequest().msg).toEqual({ epoch: null, cursor: 0, limit: 50 });
  });

  it('renews only the displayed chat and cools navigation to compact without downloading hidden history', async () => {
    const first = await h!.pair('c1');
    first.client.emit(channelUp('/repo', 'First', [ATTENTION_CAPABILITY]));
    const second = await h!.pair('c2');
    second.client.emit(channelUp('/repo', 'Second', [ATTENTION_CAPABILITY]));
    h!.manager.setChatVisible('c1');
    first.client.clearSent();
    second.client.clearSent();
    await vi.advanceTimersByTimeAsync(WATCH_COOLDOWN_MS);
    expect(second.client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
    await vi.advanceTimersByTimeAsync(WATCH_RENEW_MS);
    expect(first.client.sentOfKind('control.watch_request').at(-1)?.level).toBe('detail');
    expect(second.client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
    expect(second.client.sentOfKind('control.recovery_request')).toHaveLength(0);
    expect(second.client.sentOfKind('control.recent_turns_request')).toHaveLength(0);

    h!.manager.setChatVisible(null); // Explore, a device page, or a modal replaces chat.
    await vi.advanceTimersByTimeAsync(WATCH_COOLDOWN_MS);
    expect(first.client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
  });

  it('negotiates offscreen joins before history while legacy peers retain their backfill', async () => {
    h!.manager.setChatVisible(null);
    const modern = await h!.pair('modern');
    modern.client.emit(channelUp('/repo', 'Modern', [ATTENTION_CAPABILITY]));
    expect(modern.client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
    expect(modern.client.sentOfKind('control.recovery_request')).toHaveLength(0);
    expect(modern.client.sentOfKind('control.recent_turns_request')).toHaveLength(0);
    const legacy = await h!.pair('legacy');
    legacy.client.emit(channelUp('/repo', 'Legacy'));
    expect(legacy.client.sentOfKind('control.watch_request')).toHaveLength(0);
    expect(legacy.client.sentOfKind('control.recent_turns_request')).toHaveLength(1);
  });

  it.each(['session', 'listener'])('preserves the saved phone identity when a %s QR changes only endpoint', async (kind) => {
    const channelId = kind === 'session' ? 'refresh-session' : 'refresh-station';
    const qr = (url: string, pub = `peer-${channelId}`): string => JSON.stringify({
      v: 1, kind, channelId, pub, transport: { kind: 'devtunnel', url },
    });
    await h!.manager.addByQr(qr('wss://old.example.ms'));
    const saved = kind === 'session'
      ? (await loadSessions())[0]!.pairing
      : (await loadDevices())[0]!;
    await h!.manager.addByQr(qr('wss://new.example.ms'));
    expect(pairingIdentities.at(-1)).toMatchObject({
      publicKeyB64: saved.publicKeyB64, privateKeyJwk: saved.privateKeyJwk,
    });
    const reused = pairingIdentities.length;
    await h!.manager.addByQr(qr('wss://new.example.ms', 'new-laptop-key'));
    expect(pairingIdentities).toHaveLength(reused); // A different laptop key must not inherit the saved phone key.
  });

  it('stops leases on pagehide and preserves intentionally silent busy sessions until foreground', async () => {
    await h!.init();
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    client.emit(stateSnapshot({ busy: true, capabilities: [ATTENTION_CAPABILITY] }));
    const watchedId = client.sentOfKind('control.watch_request').at(-1)?.watchId;
    window.dispatchEvent(new Event('pagehide'));
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('off');
    expect(client.sentOfKind('control.watch_request').at(-1)?.watchId).toBe(watchedId);
    client.clearSent();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(client.sentOfKind('control.watch_request')).toHaveLength(0);
    expect(h!.active()?.timeline.busy).toBe(true);
    expect(h!.active()?.status).toBe('live');
    expect(h!.client('c1')).toBe(client);
    window.dispatchEvent(new Event('online'));
    await h!.flush();
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('detail');
    expect(client.sentOfKind('control.watch_request').at(-1)?.watchId).not.toBe(watchedId);
    expect(client.sentOfKind('control.recovery_request')).toHaveLength(1);
  });

  it('shows compact unread and needs-attention without requesting or marking invisible content read', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    h!.manager.setChatVisible(null);
    client.clearSent();
    client.emit(sessionStatus({ busy: true, epoch: 'e', cursor: 7, pendingApprovals: 2, pendingForms: 1 }));
    await h!.flush();
    expect(h!.active()?.timeline.busy).toBe(true);
    expect(h!.active()?.unreadCount).toBe(7);
    expect(h!.active()?.needsAttention).toBe(3);
    expect(h!.active()?.timeline.items).toHaveLength(0);
    expect(client.sentOfKind('control.recovery_request')).toHaveLength(0);
    expect(await loadTranscript('c1')).toBeNull();
  });

  it('pages catch-up with stable dedup, a single gap, and authoritative current prompts', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    client.emit(stateSnapshot({ approvals: [], capabilities: [ATTENTION_CAPABILITY] }));
    const stale = approvalRequest('old', 'write_file', {}, [{ id: 'yes', label: 'Yes' }]);
    const page = recovery([
      { sequence: 1, message: assistantMessage('Done', 'a1') },
      { sequence: 2, message: toolStart('t1', 'read_file') },
      { sequence: 3, message: stale },
    ], 'e', 3, true, true);
    client.emit(page);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.sentOfKind('control.recovery_request').at(-1)).toMatchObject({ epoch: 'e', cursor: 3 });
    client.emit(recovery([{ sequence: 4, message: toolComplete('t1', 'read_file', false, 'Failed') }], 'e', 4));
    await vi.advanceTimersByTimeAsync(1);
    client.emit(page);
    await vi.advanceTimersByTimeAsync(1);
    client.emit(recovery([], 'e', 4));
    await vi.advanceTimersByTimeAsync(1);
    expect(h!.active()?.timeline.items.filter((item) => item.id === 'a1')).toHaveLength(1);
    expect(h!.active()?.timeline.items.filter((item) => item.id === 't1')).toHaveLength(1);
    expect(h!.active()?.timeline.items.filter((item) => item.id === 'recovery-gap:e')).toHaveLength(1);
    expect(h!.active()?.timeline.items.find((item) => item.id === 'catchup-summary:e:0')).toMatchObject({
      text: '1 messages · 2 tool updates · 1 failures since last viewed',
    });
    expect(h!.active()?.timeline.approvals).toHaveLength(0);
    expect(h!.active()?.unreadCount).toBeUndefined();
    expect((await loadTranscript('c1'))?.recovery).toMatchObject({ epoch: 'e', cursor: 4, viewedCursor: 4 });
  });

  it('deduplicates live/replay races and does not advance the received cursor over missing activity', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    const live = { ...assistantMessage('Live tail', 'a2'), recoveryEpoch: 'e', recoverySequence: 2 };
    client.emit(live);
    client.emit(live);
    await vi.advanceTimersByTimeAsync(801);
    expect((await loadTranscript('c1'))?.recovery?.cursor ?? 0).toBe(0);
    client.emit(recovery([
      { sequence: 1, message: assistantMessage('Missed', 'a1') },
      { sequence: 2, message: live },
    ], 'e', 2));
    await vi.advanceTimersByTimeAsync(1);
    expect(h!.active()?.timeline.items.filter((item) => item.kind === 'assistant')).toHaveLength(2);
    expect(h!.active()?.timeline.items.filter((item) => item.kind === 'assistant').map((item) => item.id)).toEqual(['a1', 'a2']);
    expect((await loadTranscript('c1'))?.recovery?.cursor).toBe(2);
    client.clearSent();
    const droppedTail = { ...assistantMessage('After queue drop', 'a4'), recoveryEpoch: 'e', recoverySequence: 4 };
    client.emit(droppedTail);
    await vi.advanceTimersByTimeAsync(801);
    expect(client.sentOfKind('control.recovery_request').at(-1)).toMatchObject({ epoch: 'e', cursor: 2 });
    expect((await loadTranscript('c1'))?.recovery?.cursor).toBe(2);
    client.emit(recovery([
      { sequence: 3, message: assistantMessage('Dropped frame', 'a3') },
      { sequence: 4, message: droppedTail },
    ], 'e', 4));
    await vi.advanceTimersByTimeAsync(1);
    expect((await loadTranscript('c1'))?.recovery?.cursor).toBe(4);
    expect(h!.active()?.timeline.items.filter((item) => item.kind === 'assistant').map((item) => item.id))
      .toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('does not let a live tail close an in-flight recovery page or mark the backlog viewed', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    client.emit(recovery([{ sequence: 1, message: assistantMessage('First', 'a1') }], 'e', 1, true));
    await vi.advanceTimersByTimeAsync(1);
    const live = { ...assistantMessage('Live', 'a2'), recoveryEpoch: 'e', recoverySequence: 2 };
    client.emit(live);
    await vi.advanceTimersByTimeAsync(1);
    expect((await loadTranscript('c1'))?.recovery).toMatchObject({ cursor: 2, viewedCursor: 0 });
    client.emit(recovery([
      { sequence: 2, message: live },
      { sequence: 3, message: assistantMessage('Last', 'a3') },
    ], 'e', 3));
    await vi.advanceTimersByTimeAsync(1);
    expect((await loadTranscript('c1'))?.recovery).toMatchObject({ cursor: 3, viewedCursor: 3 });
    expect(h!.active()?.timeline.items.filter((item) => item.kind === 'assistant')).toHaveLength(3);
  });

  it('surfaces failed storage and retries from the last successfully retained cursor', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    const original = preferencesStorage.setItem;
    const fail = vi.spyOn(preferencesStorage, 'setItem').mockImplementation(async (key, value) => {
      if (key.includes('transcript')) throw new Error('Quota');
      return original(key, value);
    });

    client.emit(recovery([{ sequence: 1, message: assistantMessage('Keep me', 'a1') }], 'e', 1, true));
    await vi.advanceTimersByTimeAsync(1);
    expect(h!.active()?.timeline.items.some((item) => item.id === 'recovery-storage-error')).toBe(true);
    expect(await loadTranscript('c1')).toBeNull();
    fail.mockRestore();
    h!.manager.setChatVisible(null);
    await vi.advanceTimersByTimeAsync(WATCH_COOLDOWN_MS);
    h!.manager.setChatVisible('c1');
    expect(client.sentOfKind('control.recovery_request').at(-1)).toMatchObject({ epoch: null, cursor: 0 });
    client.emit(recovery([{ sequence: 1, message: assistantMessage('Keep me', 'a1') }], 'e', 1));
    await vi.advanceTimersByTimeAsync(1);
    expect((await loadTranscript('c1'))?.recovery?.cursor).toBe(1);
    expect(h!.active()?.timeline.items.filter((item) => item.id === 'a1')).toHaveLength(1);
  });

  it('retains offscreen received position separately from viewed progress', async () => {
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    h!.manager.setChatVisible(null);
    client.emit(recovery([{ sequence: 1, message: assistantMessage('Missed', 'a1') }], 'e', 1));
    await vi.advanceTimersByTimeAsync(1);
    expect((await loadTranscript('c1'))?.recovery).toMatchObject({ cursor: 1, viewedCursor: 0, viewedEpoch: null });
    client.emit(sessionStatus({ busy: false, epoch: 'e', cursor: 2, pendingApprovals: 0, pendingForms: 0 }));
    expect(h!.active()?.unreadCount).toBe(2);
    h!.manager.setActive('c1');
    expect(h!.active()?.unreadCount).toBe(2);
  });

  it('restores the saved recovery position and reconnects the visible foreground chat first', async () => {
    await h!.init();
    const { client } = await h!.pair('c1');
    client.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    client.emit(recovery([{ sequence: 1, message: assistantMessage('Saved', 'a1') }], 'e', 1));
    await vi.advanceTimersByTimeAsync(801);
    h!.dispose();
    h = makeManager();
    await h.init();
    const restored = h.client('c1');
    restored.emit(channelUp('/repo', 'Chat', [ATTENTION_CAPABILITY]));
    expect(restored.sentOfKind('control.recovery_request').at(-1)).toMatchObject({ epoch: 'e', cursor: 1 });
    window.dispatchEvent(new Event('pagehide'));
    restored.setStatus('disconnected');
    window.dispatchEvent(new Event('pageshow'));
    await h.flush();
    await vi.advanceTimersByTimeAsync(1);
    const fresh = h.client('c1');
    expect(fresh).not.toBe(restored);
    expect(fresh.sentOfKind('control.watch_request').at(-1)?.level).toBe('detail');
    expect(fresh.sentOfKind('control.recovery_request').at(-1)).toMatchObject({ epoch: 'e', cursor: 1 });
    expect(h.active()?.timeline.items.filter((item) => item.id === 'a1')).toHaveLength(1);
  });

  afterEach(() => {
    h?.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('goes offline on socket drop and reconnects with a recent-turns request', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.heartbeat(5, false));
    client.emit(B.assistantDelta('live tail', 'm1'));
    await h!.flush();
    await vi.advanceTimersByTimeAsync(800);
    await h!.flush();

    expect(h!.active()?.timeline.latestTurnIndex).toBe(5);
    client.setStatus('disconnected');
    await h!.flush();
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('Connection lost — reconnect to resume.');

    await h!.manager.reconnect('c1');
    await h!.flush();

    const fresh = h!.client('c1');
    expect(fresh).not.toBe(client);
    // Reconnect backfill now flows through the extension's in-memory recent-turns snapshot, which is
    // self-contained (no incremental forward-catchup paging).
    expect(fresh.sentOfKind('control.history_request')).toHaveLength(0);
    const requests = fresh.sentOfKind('control.recent_turns_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].limit).toBe(50);
  });
});
