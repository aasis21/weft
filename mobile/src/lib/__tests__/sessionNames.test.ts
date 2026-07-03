import { creativeName } from '@/lib/sessionNames';

describe('creativeName', () => {
  it('is deterministic for a given channelId', () => {
    expect(creativeName('abc123def456')).toBe(creativeName('abc123def456'));
  });

  it('returns a non-empty friendly label (not the raw Session <id> fallback)', () => {
    const name = creativeName('feedface00');
    expect(name).toBeTruthy();
    expect(name.startsWith('Session ')).toBe(false);
  });

  it('spreads different ids across the wordlist', () => {
    const names = new Set(
      Array.from({ length: 40 }, (_, i) => creativeName(`channel-${i}-xyz`)),
    );
    // With ~100 names and 40 distinct ids we expect plenty of variety, not one collapsed value.
    expect(names.size).toBeGreaterThan(10);
  });
});
