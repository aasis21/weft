import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeWeftClient';
import * as B from '@/test/helpers/builders';
import { loadDevices } from '@/lib/devices';
import { recoveryReason } from '@/ui/recovery/RecoveryBar';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

describe('scenario: protocol v3 session link', () => {
  let h: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    h = makeManager();
  });

  afterEach(() => {
    h.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('is not live until the laptop\u2019s link_ready, replies with the same generation, then runs state + catch-up', async () => {
    const { client } = await h.pair('c1');
    client.clearSent();
    client.emit(B.linkedChannelUp('c1', 'sess-1', 2, 'C:\\repo', 'Linked'));
    client.emit(B.heartbeat(1, false));
    await h.flush();

    expect(h.byChannel('c1')?.status).toBe('connecting');
    expect(h.byChannel('c1')?.link).toEqual({ generation: 2, ready: false, protocolVersion: 3 });
    expect(client.sentOfKind('control.link_ready')).toHaveLength(0);
    expect(client.sentOfKind('control.state_request')).toHaveLength(0);

    client.emit(B.linkReady({ linkGeneration: 2, controllerRevision: 7 }));
    await h.flush();

    expect(h.byChannel('c1')?.status).toBe('live');
    expect(h.byChannel('c1')?.link).toMatchObject({ generation: 2, ready: true, controllerRevision: 7 });
    expect(client.sentOfKind('control.link_ready')).toEqual([{ linkGeneration: 2, controllerRevision: 7 }]);
    expect(client.sentOfKind('control.state_request')).toHaveLength(1);
    expect(client.sentOfKind('control.recent_turns_request')).toHaveLength(1);

    // The laptop re-sends link_ready until it sees the reply: answer it, but don't redo catch-up.
    client.emit(B.linkReady({ linkGeneration: 2, controllerRevision: 7 }));
    await h.flush();
    expect(client.sentOfKind('control.link_ready')).toHaveLength(2);
    expect(client.sentOfKind('control.state_request')).toHaveLength(1);
  });

  it('drops channel_up / link_ready from an older link generation', async () => {
    const { client } = await h.pair('c1');
    client.emit(B.linkedChannelUp('c1', 'sess-1', 3));
    await h.flush();
    client.clearSent();

    client.emit(B.linkReady({ linkGeneration: 2, controllerRevision: 1 }));
    client.emit(B.linkedChannelUp('c1', 'sess-1', 2, 'C:\\stale', 'Stale'));
    await h.flush();
    expect(h.byChannel('c1')?.status).toBe('connecting');
    expect(h.byChannel('c1')?.link).toMatchObject({ generation: 3, ready: false });
    expect(h.byChannel('c1')?.meta.cwd).not.toBe('C:\\stale');
    expect(client.sentOfKind('control.link_ready')).toHaveLength(0);

    client.emit(B.linkReady({ linkGeneration: 3, controllerRevision: 1 }));
    await h.flush();
    expect(h.byChannel('c1')?.status).toBe('live');
    expect(client.sentOfKind('control.link_ready')).toEqual([{ linkGeneration: 3, controllerRevision: 1 }]);
  });

  it('a new socket must link again before the session is live', async () => {
    const { client } = await h.pair('c1');
    client.emit(B.linkedChannelUp('c1', 'sess-1', 1));
    client.emit(B.linkReady({ linkGeneration: 1, controllerRevision: 1 }));
    await h.flush();
    expect(h.byChannel('c1')?.status).toBe('live');

    client.setStatus('disconnected');
    await h.manager.reconnect('c1');
    await h.flush();
    const next = registry.get('c1')!;
    next.emit(B.linkedChannelUp('c1', 'sess-1', 1));
    next.emit(B.heartbeat(2, false));
    await h.flush();
    expect(h.byChannel('c1')?.status).toBe('connecting');
    next.emit(B.linkReady({ linkGeneration: 1, controllerRevision: 1 }));
    await h.flush();
    expect(h.byChannel('c1')?.status).toBe('live');
  });

  it('shows update-required for a laptop that speaks an older protocol, and tells the laptop', async () => {
    const { client } = await h.pair('old');
    const up = B.channelUp('old', 'sess-old', 'C:\\repo', 'Old laptop');
    const legacy = { ...up, msg: { cwd: 'C:\\repo', title: 'Old laptop' } } as typeof up;
    client.emit(legacy);
    await h.flush();

    const view = h.byChannel('old')!;
    expect(view.status).toBe('error');
    expect(view.error).toBe('Weft on your laptop needs an update.');
    expect(view.link).toMatchObject({ updateRequired: 'laptop', protocolVersion: null });
    expect(recoveryReason(view, { known: false, reachable: false })).toBe('update-required');
    expect(client.sentOfKind('control.update_required')).toEqual([
      { minVersion: 3, peerVersion: null, side: 'laptop' },
    ]);

    // Nothing the old laptop sends afterwards makes it live.
    client.emit(B.heartbeat(3, false));
    await h.flush();
    expect(h.byChannel('old')?.status).toBe('error');
  });

  it('handles update_required from the laptop on the session link', async () => {
    const { client } = await h.pair('c1');
    client.emit(B.updateRequired({ side: 'phone', peerVersion: 2 }));
    await h.flush();
    expect(h.byChannel('c1')).toMatchObject({
      status: 'error',
      error: 'Update Weft on this phone to keep using this session.',
      link: { updateRequired: 'phone' },
    });
  });
});

describe('scenario: Station health, endpoint updates and recover()', () => {
  let h: ReturnType<typeof makeManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    h = makeManager();
  });

  afterEach(() => {
    h.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  async function stationAndSession(sessionId = 'sess-1') {
    await h.manager.addByQr(listenerQr('station'));
    await h.flush();
    const station = registry.get('station')!;
    station.emit(B.projectList([], 'Akash-Laptop-With-A-Very-Long-Name'));
    const { client } = await h.pair('c1');
    client.emit(B.channelUp('c1', sessionId, 'C:\\repo', 'Work'));
    await h.flush();
    return { station, client };
  }

  it('asks Station for session health when the link drops, and stores the verdict', async () => {
    const { station, client } = await stationAndSession();
    station.clearSent();

    client.setStatus('disconnected');
    await h.flush();
    expect(station.sentOfKind('control.session_health_request')).toEqual([{ sessionId: 'sess-1' }]);

    station.emit(B.sessionHealthMsg({ sessionId: 'sess-1', label: 'stalled', reason: 'owner-unknown', freshAt: 5 }));
    await h.flush();
    expect(h.byChannel('c1')?.health).toMatchObject({ label: 'stalled', reason: 'owner-unknown', freshAt: 5 });
    expect(recoveryReason(h.byChannel('c1')!, { known: true, reachable: true })).toBe('owner-unknown');
  });

  it('updates the stored device address on endpoint_update and reconnects over it, ignoring stale revisions', async () => {
    await h.manager.addByQr(listenerQr('station'));
    await h.flush();
    const station = registry.get('station')!;
    const descriptor = { kind: 'devtunnel' as const, url: 'wss://new-tunnel.example/relay' };

    station.emit(B.endpointUpdate({ endpointRevision: 2, descriptor }));
    await vi.advanceTimersByTimeAsync(0);
    await h.flush();
    expect(h.snapshot().devices[0]?.transport).toEqual(descriptor);
    expect((await loadDevices())[0]?.transport).toEqual(descriptor);
    expect(registry.forChannel('station')).toHaveLength(2);

    registry.get('station')!.emit(B.endpointUpdate({ endpointRevision: 1, descriptor: { kind: 'local' } as never }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.snapshot().devices[0]?.transport).toEqual(descriptor);
    expect(registry.forChannel('station')).toHaveLength(2);
  });

  it('recover(): a quick socket retry that links needs nothing from Station', async () => {
    const { station, client } = await stationAndSession();
    client.setStatus('disconnected');
    await h.flush();
    station.clearSent();

    const recovering = h.manager.recover('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('retrying');
    expect(registry.forChannel('c1')).toHaveLength(2);
    registry.get('c1')!.emit(B.channelUp('c1', 'sess-1', 'C:\\repo', 'Work'));
    await vi.advanceTimersByTimeAsync(300);
    await recovering;

    expect(h.byChannel('c1')?.recovery).toMatchObject({ phase: 'done', doneVia: 'reconnect' });
    expect(station.sentOfKind('control.open_session')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.byChannel('c1')?.recovery).toBeUndefined();
  });

  it('recover(): escalates to Station and streams lifecycle stages into the bar until the reopened session links', async () => {
    const { station, client } = await stationAndSession();
    client.setStatus('disconnected');
    await h.flush();

    const recovering = h.manager.recover('c1');
    await vi.advanceTimersByTimeAsync(5_100);
    await recovering;

    const open = station.sentOfKind('control.open_session')[0]!;
    expect(open).toEqual({
      requestId: expect.stringMatching(/^recover-/),
      target: { sessionId: 'sess-1' },
      options: { permissionMode: 'default', title: null },
    });
    expect(h.byChannel('c1')?.recovery).toMatchObject({
      phase: 'asking',
      deviceName: 'Akash-Laptop-With-A-Very-Long-Name',
      requestId: open.requestId,
    });
    expect(station.sentOfKind('control.session_health_request').at(-1)).toEqual({ sessionId: 'sess-1' });

    const requestId = open.requestId as string;
    station.emit(B.lifecycleStatus({ requestId, revision: 1, stage: 'resolving' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('asking');
    station.emit(B.lifecycleStatus({ requestId, revision: 2, stage: 'dispatching', result: { action: 'resume' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery).toMatchObject({ phase: 'resuming', revision: 2 });
    station.emit(B.lifecycleStatus({ requestId, revision: 3, stage: 'preparing-link', result: { action: 'resume' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('linking');

    station.emit(B.lifecycleStatus({
      requestId,
      revision: 4,
      stage: 'preparing-link',
      outcome: 'done',
      result: {
        action: 'resume',
        sessionId: 'sess-1',
        payload: { v: 1, channelId: 'resumed', pub: 'resumed-pub', kind: 'session', transport: { kind: 'local' } },
      },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h.flush();
    registry.get('resumed')!.emit(B.channelUp('resumed', 'sess-1', 'C:\\repo', 'Work'));
    await vi.advanceTimersByTimeAsync(300);
    await h.flush();

    expect(h.byChannel('c1')).toBeUndefined();
    expect(h.byChannel('resumed')).toMatchObject({ status: 'live', recovery: { phase: 'done', doneVia: 'resume' } });
    expect(h.snapshot().activeId).toBe('resumed');
  });

  it('recover(): a takeover waits for "Take over" and confirms Station\u2019s exact challenge', async () => {
    const { station, client } = await stationAndSession();
    client.setStatus('disconnected');
    await h.flush();
    const recovering = h.manager.recover('c1');
    await vi.advanceTimersByTimeAsync(5_100);
    await recovering;
    const requestId = station.sentOfKind('control.open_session')[0]!.requestId as string;

    station.emit(B.lifecycleStatus({
      requestId,
      revision: 2,
      stage: 'awaiting-confirmation',
      reason: 'controller-conflict',
      result: { challenge: { challengeId: 'ch-2', runtimeId: 'rt-1', controllerRevision: 4 } },
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery).toMatchObject({ phase: 'controller-conflict', challengeId: 'ch-2', revision: 2 });
    expect(station.sentOfKind('control.takeover_confirm')).toHaveLength(0);

    void h.manager.confirmRecoveryTakeover('c1');
    await h.flush();
    expect(station.sentOfKind('control.takeover_confirm')).toEqual([{ requestId, challengeId: 'ch-2', revision: 2 }]);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('repairing');
  });

  it('recover(): ✕ cancels the Station request with its revision and clears the bar', async () => {
    const { station, client } = await stationAndSession();
    client.setStatus('disconnected');
    await h.flush();
    const recovering = h.manager.recover('c1');
    await vi.advanceTimersByTimeAsync(5_100);
    await recovering;
    const requestId = station.sentOfKind('control.open_session')[0]!.requestId as string;
    station.emit(B.lifecycleStatus({ requestId, revision: 3, stage: 'dispatching', result: { action: 'repair' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('repairing');

    void h.manager.cancelRecovery('c1');
    await h.flush();
    expect(station.sentOfKind('control.lifecycle_cancel')).toEqual([{ requestId, revision: 3 }]);
    expect(h.byChannel('c1')?.recovery).toBeUndefined();

    // A late stage from the cancelled request no longer drives the bar.
    station.emit(B.lifecycleStatus({ requestId, revision: 4, stage: 'preparing-link', result: { action: 'repair' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery).toBeUndefined();
  });

  it('recover(): maps a failed Station request to its row', async () => {
    const { station, client } = await stationAndSession();
    client.setStatus('disconnected');
    await h.flush();
    const recovering = h.manager.recover('c1');
    await vi.advanceTimersByTimeAsync(5_100);
    await recovering;
    const requestId = station.sentOfKind('control.open_session')[0]!.requestId as string;
    station.emit(B.lifecycleStatus({ requestId, revision: 1, stage: 'resolving', outcome: 'failed', reason: 'not-found' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.byChannel('c1')?.recovery?.phase).toBe('not-found');
  });

  it('recover(): without a Station it shows the no-Station guidance', async () => {
    const { client } = await h.pair('lonely');
    client.emit(B.channelUp('lonely', 'sess-lonely', 'C:\\repo', 'Alone'));
    await h.flush();
    client.setStatus('disconnected');
    await h.flush();

    const recovering = h.manager.recover('lonely');
    await vi.advanceTimersByTimeAsync(5_100);
    await recovering;
    expect(h.byChannel('lonely')?.recovery?.phase).toBe('no-station');
  });

  it('pull-to-refresh: a linked session reloads recent turns; an offline one recovers', async () => {
    const { client } = await stationAndSession();
    client.clearSent();
    h.manager.refresh('c1');
    await h.flush();
    expect(client.sentOfKind('control.recent_turns_request')).toHaveLength(1);
    expect(h.byChannel('c1')?.recovery).toBeUndefined();

    client.setStatus('disconnected');
    await h.flush();
    h.manager.refresh('c1');
    await h.flush();
    expect(h.byChannel('c1')?.recovery?.phase).toBe('retrying');
  });

  it('after a reconnect\u2019s catch-up, a tool still running before the laptop\u2019s latest turn is finished-unknown', async () => {
    const { client } = await h.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', 'C:\\repo', 'Work'));
    client.emit(B.stamp(B.toolStart('t-old', 'read_file', { path: 'a' }), { ts: 1_000 }));
    await h.flush();
    expect(h.byChannel('c1')?.timeline.items.find((i) => i.id === 't-old')).toMatchObject({ status: 'running' });

    client.setStatus('disconnected');
    await h.manager.reconnect('c1');
    await h.flush();
    const next = registry.get('c1')!;
    next.emit(B.channelUp('c1', 'sess-1', 'C:\\repo', 'Work'));
    next.emit(B.stamp(B.toolStart('t-new', 'write_file', { path: 'b' }), { ts: 3_000 }));
    next.emit(B.recentTurnsSnapshot([B.recentTurnItem('assistant', 'Done reading.', 2_000, 'a-2')]));
    await h.flush();

    const items = h.byChannel('c1')!.timeline.items;
    expect(items.find((i) => i.id === 't-old')).toMatchObject({ status: 'unknown' });
    expect(items.find((i) => i.id === 't-new')).toMatchObject({ status: 'running' });
  });
});
