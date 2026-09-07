import { test, expect } from '@playwright/test';

// JOURNEY — Connect / navigation (real browser, phone viewport 412×915).
//
// Proves the multi-screen navigation a first-run user actually walks: the web
// onboarding Landing, its hand-off to the scanner-first Join screen, the
// touch-first controls, and finally landing inside a real Session surface via
// the demo. This is the "does the app route/render between screens for a
// real user" question that only a real browser can answer — protocol breadth
// lives in the Vitest scenario suite, not here.
test.describe('Journey: connect & navigate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // First run (no stored sessions): the web build shows the onboarding Landing.
    // Parallel browser workers can make Capacitor's first storage-plugin load exceed
    // Playwright's five-second assertion default even though boot is progressing normally.
    await expect(page.locator('.landing-shell')).toBeVisible({ timeout: 15_000 });
  });

  test('Landing renders the hero, pairing CTA, and install command', async ({ page }) => {
    await expect(page.locator('.landing-hero h1')).toBeVisible();
    // The hero owns the primary pairing CTA (a second identical CTA lives in the
    // page finale, so scope to the hero to name exactly one).
    const hero = page.locator('.landing-hero');
    await expect(hero.getByRole('button', { name: 'Scan QR to pair' })).toBeVisible();
    await expect(hero.getByRole('button', { name: 'Try the demo' })).toBeVisible();
    // The one-line install command is rendered inside step 1 of "How it works".
    await expect(page.locator('.install-code')).toBeVisible();
  });

  test('"Scan QR to pair" opens the touch-first scanner screen', async ({ page }) => {
    await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();

    // Navigated Landing → Join.
    await expect(page.locator('.join-shell')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Scan to connect' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Scan pairing QR' })).toBeVisible();
    await expect(page.getByLabel('Manual pairing JSON')).toHaveCount(0);
  });

  test('touch devices omit the desktop-only paste shortcut', async ({ page }) => {
    await expect(page.locator('.landing-hero').getByRole('button', { name: 'Paste a code' })).toHaveCount(0);
  });

  test('Landing → Join → Back → Demo reaches a live session surface', async ({ page }) => {
    await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();
    await expect(page.locator('.join-shell')).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();

    // Now inside the chat surface: header + status render, composer is present.
    await expect(page.locator('.weft-session')).toBeVisible();
    await expect(page.locator('.status-bar')).toBeVisible();
    await expect(page.locator('.status-title')).toContainText('Demo session');
    await expect(page.locator('.composer')).toBeVisible();
  });

  test('the demo can also be launched straight from the Landing hero', async ({ page }) => {
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.weft-session')).toBeVisible();
    await expect(page.locator('.status-bar')).toBeVisible();
  });
});
