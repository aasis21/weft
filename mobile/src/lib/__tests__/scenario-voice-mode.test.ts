import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: voice mode control', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('notifies the active live session when voice mode enters and exits', async () => {
    const { client } = await h!.pair('voice-1');
    client.emit(B.channelUp('voice-1', 'sess-voice', 'C:\\repo', 'Voice session'));
    await h!.flush();
    client.clearSent();

    await h!.manager.setVoiceMode(true);
    await h!.manager.setVoiceMode(false);
    await h!.flush();

    expect(client.voiceModeStates()).toEqual([true, false]);
  });

  it('does not send voice mode for non-live sessions', async () => {
    const { client } = await h!.pair('voice-connecting');
    client.clearSent();

    await h!.manager.setVoiceMode(true);
    await h!.flush();

    expect(client.voiceModeStates()).toEqual([]);
  });
});
