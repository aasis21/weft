import { test, expect } from '@playwright/test';

// JOURNEY — Session management via the drawer (real browser, phone viewport).
//
// Proves the drawer + confirm + routing flow a real user drives: open the session
// drawer, see the joined session listed with its demo tag, jump to "join another"
// (real navigation to the Join screen), and leave a session through the two-step
// confirm — Cancel keeps it, Leave removes it and routes back to the onboarding
// Landing once the last session is gone.
//
// NOTE ON MULTI-SESSION: the in-app demo hard-codes one Copilot sessionId, and the
// manager dedupes cards by sessionId (a resume collapses onto the same card), so a
// real browser can only stand up ONE demo session. The multi-session breadth —
// switching the active card, unread clearing, dedupe, and "active follows on
// remove" across several sessions — is proven deterministically in the Vitest L2
// scenarios and the SessionDrawer component test, where session ids are injectable.

test.describe('Journey: session management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.weft-session')).toBeVisible();
  });

  test('the drawer lists the joined session and can be dismissed', async ({ page }) => {
    await page.locator('.drawer-btn').click();
    await expect(page.locator('.drawer')).toBeVisible();
    await expect(page.locator('.drawer-title')).toHaveText('SESSIONS');

    const row = page.locator('.session-row').first();
    await expect(row.locator('.session-title')).toContainText('Demo session');
    await expect(row.locator('.tag.demo')).toContainText('demo');
    // The active session is highlighted.
    await expect(row).toHaveClass(/current/);

    // Dismiss via the drawer's Close (✕) control.
    await page.locator('.drawer-head button[title="Close"]').click();
    await expect(page.locator('.drawer')).toHaveCount(0);
  });

  test('"Join another Copilot session" navigates to the Join screen', async ({ page }) => {
    await page.locator('.drawer-btn').click();
    await page.locator('.drawer-add').click();
    await expect(page.locator('.join-shell')).toBeVisible();
    await expect(page.locator('.join-head h2')).toContainText('Point your camera at the laptop QR');
  });

  test('leaving a session is a two-step confirm: Cancel keeps it, Leave removes it', async ({ page }) => {
    // Open the drawer and trigger a leave on the row.
    await page.locator('.drawer-btn').click();
    await page.locator('.session-row').first().locator('.row-x').click();

    // The confirm dialog appears (the drawer closes behind it).
    const confirm = page.getByRole('dialog', { name: 'Leave this session?' });
    await expect(confirm).toBeVisible();

    // Cancel keeps the session — we are still in the chat surface.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.weft-session')).toBeVisible();

    // Trigger it again and confirm the leave.
    await page.locator('.drawer-btn').click();
    await page.locator('.session-row').first().locator('.row-x').click();
    const confirm2 = page.getByRole('dialog', { name: 'Leave this session?' });
    await confirm2.getByRole('button', { name: 'Leave' }).click();

    // Removing the last session routes back to the onboarding Landing.
    await expect(page.locator('.landing-shell')).toBeVisible();
    await expect(page.locator('.weft-session')).toHaveCount(0);
  });

  test('the status-bar menu also offers a "Leave this session" action', async ({ page }) => {
    await page.locator('.menu-btn').click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Join another session' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Leave this session' }).click();

    // Same two-step confirm, reached from the header instead of the drawer.
    await expect(page.getByRole('dialog', { name: 'Leave this session?' })).toBeVisible();
  });
});
