import { describe, expect, it } from 'vitest';
import { peekPreference } from '@/test/helpers/mockPreferences';
import { createPreferencesStorage } from '@/services/persistence/preferencesStorage';

describe('createPreferencesStorage', () => {
  it('round-trips string values through Capacitor Preferences', async () => {
    const storage = createPreferencesStorage();

    await storage.setItem('persist:helm', '{"sessions":[]}');

    await expect(storage.getItem('persist:helm')).resolves.toBe('{"sessions":[]}');
    expect(peekPreference('persist:helm')).toBe('{"sessions":[]}');
  });

  it('removeItem deletes stored values', async () => {
    const storage = createPreferencesStorage();
    await storage.setItem('persist:helm', 'value');

    await storage.removeItem('persist:helm');

    await expect(storage.getItem('persist:helm')).resolves.toBeNull();
    expect(peekPreference('persist:helm')).toBeNull();
  });
});
