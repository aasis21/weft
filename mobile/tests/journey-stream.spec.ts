import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// JOURNEY — Live streaming turn (real browser, phone viewport 412×915).
//
// Runs one full demo turn end-to-end and proves it *renders live* in a real
// browser: assistant text appears, a tool card renders collapsed then expands,
// the header flips busy → idle, backfilled history sits under an "Earlier"
// divider, terminal- vs phone-origin prompts get the right device chip, and a
// phone prompt sent from the composer shows up as a right-aligned bubble.
//
// The exhaustive protocol matrix (delta coalescing, ordering, tool inline/collapse,
// busy flags, unread) is proven deterministically in the Vitest L2 scenarios; here
// we prove the same behaviours actually paint for a user.

async function startDemo(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.locator('.weft-session')).toBeVisible();
  await expect(page.locator('.status-bar')).toBeVisible();
}

test.describe('Journey: live streaming turn', () => {
  test.beforeEach(async ({ page }) => {
    await startDemo(page);
  });

  test('assistant text streams in and a tool card renders collapsed, then expands on tap', async ({ page }) => {
    // The agent's opening line streams in near the start of the turn.
    await expect(page.getByText('Let me check the mobile build')).toBeVisible({ timeout: 15_000 });

    // Tool calls render inline and collapsed by default.
    const tool = page.locator('.tc-head').first();
    await expect(tool).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tc-detail')).toHaveCount(0);

    // Tapping the header expands the tool detail.
    await tool.click();
    await expect(page.locator('.tc-detail').first()).toBeVisible();
  });

  test('the header flips from Working to a settled status as the turn ends', async ({ page }) => {
    // Early in the demo the agent is busy: the composer shows Stop and the status
    // line carries the working state.
    await expect(page.locator('.stop-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.status-line.busy')).toBeVisible();

    // Once the turn goes idle the Stop button is replaced by Send.
    await expect(page.locator('.send-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.stop-btn')).toHaveCount(0);
  });

  test('backfilled history renders above an "Earlier in this session" divider', async ({ page }) => {
    const divider = page.locator('.history-divider');
    await expect(divider).toBeVisible({ timeout: 15_000 });
    await expect(divider).toContainText('Earlier in this session');
    await expect(page.locator('.row.history').first()).toContainText('what is Weft again?');
  });

  test('a terminal-typed prompt is tagged with a "Laptop" device chip', async ({ page }) => {
    const chip = page.locator('.device-chip.laptop').first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('Laptop');
    await expect(
      page.locator('.row.user', { hasText: 'Did that build pass on the laptop?' }),
    ).toBeVisible();
  });

  test('a phone prompt sent from the composer appears right-aligned with a "This phone" chip', async ({ page }) => {
    // The composer only sends when the session is idle (Send replaces Stop), which
    // matches the real UX: you answer once the agent stops churning. Wait for Send,
    // then type and submit via the button (plain Enter inserts a newline by design).
    const send = page.locator('.send-btn');
    await expect(send).toBeVisible({ timeout: 15_000 });

    await page.locator('.composer textarea').fill('Run the tests next?');
    await send.click();

    // Live (non-history) user row, right-hand side of the thread.
    const userRow = page.locator('.row.user:not(.history)', { hasText: 'Run the tests next?' });
    await expect(userRow).toBeVisible();
    await expect(userRow.locator('.device-chip.phone')).toContainText('This phone');
  });

  test('reading earlier messages is not yanked to the bottom when new content streams in', async ({ page }) => {
    // Shrink the viewport so the transcript overflows and the thread truly scrolls.
    await page.setViewportSize({ width: 412, height: 420 });
    await expect(page.getByText('Build is green')).toBeVisible({ timeout: 15_000 });

    const scroller = page.locator('.thread-scroll');
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    const max = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(max).toBeGreaterThan(50); // sanity: there is real history above the fold

    // The demo pushes a second tool card (~5.4s) after we scrolled up.
    await expect(page.locator('.tc-head')).toHaveCount(2, { timeout: 15_000 });

    // We must still be near the top — new content must not pull the reader down.
    const top = await scroller.evaluate((el) => el.scrollTop);
    expect(top).toBeLessThan(40);
  });
});
