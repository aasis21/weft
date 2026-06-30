import { test, expect } from '@playwright/test';

// Drives the in-app Demo / Simulator (no phone needed) and asserts the v2 chat
// surface: compact top bar, inline collapsed tool cards, right-aligned user
// bubbles, a space-smart composer, the multi-session drawer, and — critically —
// no horizontal scroll at a 412px phone width.
test.describe('Helm chat UI v2', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.helm-session')).toBeVisible();
    await expect(page.locator('.status-bar')).toBeVisible();
  });

  test('compact status bar shows a live session status', async ({ page }) => {
    await expect(page.locator('.status-dot')).toBeVisible();
    await expect(page.locator('.status-title')).toContainText('Demo session');
  });

  test('tool calls render inline and collapsed, then expand on tap', async ({ page }) => {
    const tool = page.locator('.tc-head').first();
    await expect(tool).toBeVisible({ timeout: 15_000 });
    // collapsed by default
    await expect(page.locator('.tc-detail')).toHaveCount(0);
    await tool.click();
    await expect(page.locator('.tc-detail').first()).toBeVisible();
  });

  test('composer is space-smart (single row, not the legacy 136px box)', async ({ page }) => {
    const height = await page
      .locator('.composer textarea')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThan(60);
  });

  test('user prompts appear as a right-aligned bubble', async ({ page }) => {
    await page.locator('.composer textarea').fill('Run the tests next?');
    await page.keyboard.press('Enter');
    // Scope to a LIVE user row (backfilled history rows also carry .row.user).
    const userRow = page.locator('.row.user:not(.history)').first();
    await expect(userRow).toBeVisible();
    await expect(userRow).toContainText('Run the tests next?');
  });

  test('backfilled history renders above an "Earlier in this session" divider', async ({ page }) => {
    const divider = page.locator('.history-divider');
    await expect(divider).toBeVisible({ timeout: 15_000 });
    await expect(divider).toContainText('Earlier in this session');
    // The history bubbles render inside the muted history block, above the divider.
    await expect(page.locator('.row.history').first()).toContainText('what is Helm again?');
  });

  test('a terminal-typed prompt is shown with a "Laptop" device chip', async ({ page }) => {
    const chip = page.locator('.device-chip.laptop').first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('Laptop');
    // It is attached to the laptop-typed prompt relayed into the transcript.
    await expect(page.locator('.row.user', { hasText: 'Did that build pass on the laptop?' })).toBeVisible();
  });

  test('a phone-typed prompt is shown with a "This phone" device chip', async ({ page }) => {
    await page.locator('.composer textarea').fill('hello from the phone');
    await page.keyboard.press('Enter');
    const chip = page.locator('.device-chip.phone').first();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('This phone');
  });

  test('no horizontal scroll at phone width', async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBe(0);
  });

  test('reading history is not yanked to the bottom when new content streams in', async ({ page }) => {
    // Shrink the viewport so the demo transcript overflows and the thread truly scrolls.
    await page.setViewportSize({ width: 412, height: 420 });
    // Let the demo stream enough that the thread is scrollable.
    await expect(page.getByText('Build is green')).toBeVisible({ timeout: 15_000 });

    const scroller = page.locator('.thread-scroll');
    // Park the reader at the top, as if scrolled up to read earlier messages.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    const max = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(max).toBeGreaterThan(50); // sanity: there is real history above the fold

    // The demo pushes a second tool card (~5.4s) after we scrolled up.
    await expect(page.locator('.tc-head')).toHaveCount(2, { timeout: 15_000 });

    // We must still be near the top — a Live/Quiet flip or new content must not pull us down.
    const top = await scroller.evaluate((el) => el.scrollTop);
    expect(top).toBeLessThan(40);
  });

  test('session drawer opens and lists the joined session', async ({ page }) => {
    await page.locator('.drawer-btn').click();
    await expect(page.locator('.drawer-title')).toHaveText('SESSIONS');
    await expect(page.locator('.session-title').first()).toContainText('Demo session');
  });
});
