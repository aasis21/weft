import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSessions } from '@/lib/sessions';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: session rename synchronization', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('lets a changed laptop title replace a phone label and restores it when the label is cleared', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo', 'Original laptop title'));
    await h!.flush();

    h!.manager.renameSession('c1', 'Phone label');
    client.emit(B.sessionMeta('Original laptop title'));
    await h!.flush();
    expect(h!.active()?.meta).toMatchObject({
      title: 'Phone label',
      reportedTitle: 'Original laptop title',
      renamed: true,
    });

    client.emit(B.sessionMeta('Renamed on laptop'));
    await h!.flush();
    expect(h!.active()?.meta).toMatchObject({
      title: 'Renamed on laptop',
      reportedTitle: 'Renamed on laptop',
      renamed: false,
    });

    h!.manager.renameSession('c1', 'Another phone label');
    h!.manager.renameSession('c1', '');
    expect(h!.active()?.meta).toMatchObject({
      title: 'Renamed on laptop',
      reportedTitle: 'Renamed on laptop',
      renamed: false,
    });

    await h!.flush();
    expect((await loadSessions()).find((session) => session.pairing.channelId === 'c1'))
      .toMatchObject({
        title: 'Renamed on laptop',
        reportedTitle: 'Renamed on laptop',
        renamed: false,
      });
  });
});
