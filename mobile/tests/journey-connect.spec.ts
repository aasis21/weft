import { test, expect } from '@playwright/test';

// JOURNEY — Connect / navigation (real browser, phone viewport 412×915).
//
// Proves the multi-screen navigation a first-run user actually walks: the web
// onboarding Landing, its hand-off to the scanner-first Join screen, the manual
// pairing-code fallback UI, and finally landing inside a real Session surface via
// the in-app demo. This is the "does the app route/render between screens for a
// real user" question that only a real browser can answer — protocol breadth
// lives in the Vitest scenario suite, not here.
test.describe('Journey: connect & navigate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // First run (no stored sessions): the web build shows the onboarding Landing.
    await expect(page.locator('.landing-shell')).toBeVisible();
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

  test('"Scan QR to pair" opens the scanner-first Join screen with a manual fallback', async ({ page }) => {
    await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();

    // Navigated Landing → Join.
    await expect(page.locator('.join-shell')).toBeVisible();
    await expect(page.locator('.join-head h2')).toContainText('Point your camera at the laptop QR');

    // The manual fallback is collapsed by default; opening it reveals the paste box.
    const manualToggle = page.getByRole('button', { name: 'Enter code manually' });
    await expect(manualToggle).toBeVisible();
    await manualToggle.click();
    await expect(page.getByLabel('Manual pairing JSON')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair from pasted code' })).toBeVisible();
  });

  test('"Paste a code" jumps straight to Join with the manual box already open', async ({ page }) => {
    await page.locator('.landing-hero').getByRole('button', { name: 'Paste a code' }).click();
    await expect(page.locator('.join-shell')).toBeVisible();
    // initialManual → the paste box is open on arrival, no toggle needed.
    await expect(page.getByLabel('Manual pairing JSON')).toBeVisible();
  });

  test('Landing → Join → Session: the demo lands the user in a live session surface', async ({ page }) => {
    // Walk the real navigation path a user takes when they have no laptop QR handy:
    // open Join, then use the in-app Demo/Simulator to reach a Session.
    await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();
    await expect(page.locator('.join-shell')).toBeVisible();

    await page.getByRole('button', { name: 'Demo / Simulator' }).click();

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
