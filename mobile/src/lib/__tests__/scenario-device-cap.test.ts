import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

describe('scenario: MAX_DEVICES cap (#186 follow-up)', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
  });

  it('refuses an 11th device but still allows re-scanning one of the existing ten', async () => {
    await h!.init();
    for (let i = 0; i < 10; i += 1) {
      await h!.manager.addByQr(listenerQr(`listener-${i}`));
    }
    await h!.flush();
    expect(h!.snapshot().devices).toHaveLength(10);

    await expect(h!.manager.addByQr(listenerQr('listener-overflow'))).rejects.toThrow(/already have 10 devices/i);
    expect(h!.snapshot().devices).toHaveLength(10);

    // Re-scanning an already-registered device must still work even while at the cap.
    await expect(h!.manager.addByQr(listenerQr('listener-0'))).resolves.toBe('listener:listener-0');
    expect(h!.snapshot().devices).toHaveLength(10);
  });

  it('allows a new device again once one has been forgotten at the cap', async () => {
    await h!.init();
    for (let i = 0; i < 10; i += 1) {
      await h!.manager.addByQr(listenerQr(`listener-${i}`));
    }
    await h!.flush();

    await h!.manager.forgetDevice('listener-0');
    await h!.flush();
    expect(h!.snapshot().devices).toHaveLength(9);

    await expect(h!.manager.addByQr(listenerQr('listener-new'))).resolves.toBe('listener:listener-new');
    await h!.flush();
    expect(h!.snapshot().devices).toHaveLength(10);
  });
});
