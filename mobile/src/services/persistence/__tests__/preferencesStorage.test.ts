import { Preferences } from '@capacitor/preferences';
import { describe, expect, it, vi } from 'vitest';
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

  it('does not fail a durable browser write when there is no room for its mirror', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const storage = createPreferencesStorage();
    await storage.setItem('persist:pending', 'durable value');
    await expect(storage.getItem('persist:pending')).resolves.toBe('durable value');
  });

  it('reads a successful browser fallback instead of an older Preferences value', async () => {
    await memoryPreferences.set({ key: 'persist:pending', value: 'older' });
    vi.spyOn(Preferences, 'set').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const storage = createPreferencesStorage();
    await storage.setItem('persist:pending', 'newer');
    await expect(storage.getItem('persist:pending')).resolves.toBe('newer');
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
