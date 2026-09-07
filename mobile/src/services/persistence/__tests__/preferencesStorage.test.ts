import { describe, expect, it } from 'vitest';
import { memoryPreferences, peekPreference } from '@/test/helpers/mockPreferences';
import { createPreferencesStorage } from '@/services/persistence/preferencesStorage';

describe('createPreferencesStorage', () => {
  it('round-trips string values through Capacitor Preferences', async () => {
    const storage = createPreferencesStorage();

    await storage.setItem('persist:weft', '{"sessions":[]}');

    await expect(storage.getItem('persist:weft')).resolves.toBe('{"sessions":[]}');
    expect(peekPreference('persist:weft')).toBe('{"sessions":[]}');
  });

  it('removeItem deletes stored values', async () => {
    const storage = createPreferencesStorage();
    await storage.setItem('persist:weft', 'value');

    await storage.removeItem('persist:weft');

    await expect(storage.getItem('persist:weft')).resolves.toBeNull();
    expect(peekPreference('persist:weft')).toBeNull();
  });

  it('keeps native values out of localStorage and removes a legacy mirror', async () => {
    localStorage.setItem('persist:secret', 'legacy');
    const storage = createPreferencesStorage({ isNativePlatform: () => true });

    await expect(storage.getItem('persist:secret')).resolves.toBe('legacy');
    expect(peekPreference('persist:secret')).toBe('legacy');
    expect(localStorage.getItem('persist:secret')).toBeNull();

    await storage.setItem('persist:secret', 'native-only');
    expect(peekPreference('persist:secret')).toBe('native-only');
    expect(localStorage.getItem('persist:secret')).toBeNull();
  });

  it('preserves a newer legacy recovery value over a stale native snapshot', async () => {
    await memoryPreferences.set({ key: 'persist:pending', value: 'older-preference' });
    localStorage.setItem('persist:pending', 'newer-recovery-copy');
    const storage = createPreferencesStorage({ isNativePlatform: () => true });

    await expect(storage.getItem('persist:pending')).resolves.toBe('newer-recovery-copy');
    expect(peekPreference('persist:pending')).toBe('newer-recovery-copy');
    expect(localStorage.getItem('persist:pending')).toBeNull();
  });

  it('removes both native Preferences and legacy localStorage copies', async () => {
    const storage = createPreferencesStorage({ isNativePlatform: () => true });
    await memoryPreferences.set({ key: 'persist:secret', value: 'native' });
    localStorage.setItem('persist:secret', 'legacy');

    await storage.removeItem('persist:secret');

    expect(peekPreference('persist:secret')).toBeNull();
    expect(localStorage.getItem('persist:secret')).toBeNull();
  });
});
