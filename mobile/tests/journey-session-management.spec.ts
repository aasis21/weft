import { test, expect } from '@playwright/test';

// JOURNEY — Session management via the drawer (real browser, phone viewport).
//
// Proves the drawer + confirm + routing flow a real user drives: open the session
// drawer, see the joined session listed with its demo tag, jump to the scanner,
// and delete a session through the row's two-step confirmation. The status menu
// uses the larger leave-session confirmation before removing the current session.
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
    await expect(page.locator('.drawer-title')).toHaveText('WEFT');

    const row = page.locator('.session-row').first();
    await expect(row.locator('.session-title')).toContainText('Demo session');
    await expect(row.locator('.tag.demo')).toContainText('demo');
    // The active session is highlighted.
    await expect(row).toHaveClass(/current/);

    // Dismiss via the drawer's Close (✕) control.
    await page.getByTitle('Close').click();
    await expect(page.locator('.drawer')).toHaveCount(0);
  });

  test('the drawer Scan action navigates to the connect screen', async ({ page }) => {
    await page.locator('.drawer-btn').click();
    await page.locator('.drawer-actions .drawer-add-split', { hasText: 'Scan' }).click();
    await expect(page.locator('.join-session')).toBeVisible();
    await expect(page.locator('.status-title')).toHaveText('Scan to connect');
  });

  test('deleting a drawer session is a two-step inline confirmation', async ({ page }) => {
    const row = page.locator('.session-row').first();
    const openDelete = async (): Promise<void> => {
      await page.locator('.drawer-btn').click();
      await row.getByRole('button', { name: 'More actions' }).click();
      await row.getByRole('button', { name: 'Delete session' }).click();
      await expect(row.getByText('Delete?')).toBeVisible();
    };

    // Cancel keeps the session and closes the inline confirmation.
    await openDelete();
    await row.locator('button[aria-label="Cancel delete"]').click();
    await expect(row).toBeVisible();

    // Confirming removes the last session and routes back to onboarding.
    await row.getByRole('button', { name: 'More actions' }).click();
    await row.getByRole('button', { name: 'Delete session' }).click();
    await row.locator('button[aria-label="Confirm delete session"]').click();

    await expect(page.locator('.landing-shell')).toBeVisible();
    await expect(page.locator('.weft-session')).toHaveCount(0);
  });

  test('the status-bar menu offers the leave-session confirmation', async ({ page }) => {
    await page.getByRole('button', { name: 'Session menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Join another session/ })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: /Leave this session/ }).click();

    const confirm = page.getByRole('dialog', { name: 'Leave this session?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.weft-session')).toBeVisible();
  });
});
