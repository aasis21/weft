import { test, expect } from '@playwright/test';
import type { ConsoleMessage } from '@playwright/test';

// JOURNEY — Production smoke & layout (real browser, phone viewport 412×915).
//
// Pure real-browser questions jsdom cannot answer: does the production build boot
// clean (no uncaught errors, no console errors), does the composer stay pinned to
// the bottom of the viewport, is the message list actually scrollable, and is
// there zero horizontal overflow at a real phone width. No protocol assertions —
// this is about real layout, paint, and runtime health of dist/.

function trackErrors(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

async function noHorizontalScroll(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

test.describe('Journey: production smoke & layout', () => {
  test('the onboarding Landing boots clean with no console errors or overflow', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await expect(page.locator('.landing-shell')).toBeVisible();
    await expect(page.locator('.landing-hero h1')).toBeVisible();

    expect(await noHorizontalScroll(page)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('the session surface boots clean and pins the composer to the bottom', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.weft-session')).toBeVisible();
    await expect(page.locator('.composer')).toBeVisible();

    // The composer is pinned to the bottom of the 915px-tall viewport (a small
    // safe-area margin is allowed).
    const box = await page.locator('.composer').boundingBox();
    expect(box).not.toBeNull();
    const bottom = (box!.y + box!.height);
    expect(bottom).toBeGreaterThan(915 - 40);
    expect(bottom).toBeLessThanOrEqual(915 + 1);

    expect(await noHorizontalScroll(page)).toBe(0);
    expect(errors).toEqual([]);
  });

  test('the message thread scrolls when the transcript overflows a short viewport', async ({ page }) => {
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.weft-session')).toBeVisible();

    // Short viewport so the demo transcript overflows the thread.
    await page.setViewportSize({ width: 412, height: 420 });
    await expect(page.getByText('Build is green')).toBeVisible({ timeout: 15_000 });

    const scroller = page.locator('.thread-scroll');
    const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeGreaterThan(50);

    // And it genuinely scrolls (not locked).
    await scroller.evaluate((el) => {
      el.scrollTop = 30;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await noHorizontalScroll(page)).toBe(0);
  });
});
