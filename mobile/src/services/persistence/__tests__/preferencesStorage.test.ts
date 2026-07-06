import { describe, expect, it } from 'vitest';
import { peekPreference } from '@/test/helpers/mockPreferences';
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
});
