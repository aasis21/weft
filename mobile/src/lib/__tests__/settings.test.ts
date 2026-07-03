import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, getSettings, initTheme, setTheme, setVoiceAutoRelisten } from '@/lib/settings';
import { memoryPreferences } from '@/test/helpers/mockPreferences';

describe('settings persistence', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('persists settings to Preferences and localStorage and applies theme attributes', async () => {
    expect(await getSettings()).toEqual({ voiceAutoRelisten: false, theme: 'system' });

    await setVoiceAutoRelisten(true);
    await setTheme('dark');

    expect(await getSettings()).toEqual({ voiceAutoRelisten: true, theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('helm.settings.v1')).toContain('voiceAutoRelisten');
    expect((await memoryPreferences.get({ key: 'helm.settings.v1' })).value).toContain('dark');

    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    await setTheme('light');
    document.documentElement.removeAttribute('data-theme');
    await initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
