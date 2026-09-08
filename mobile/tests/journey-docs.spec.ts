import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const contentTypes: Record<string, string> = {
  'index.html': 'text/html',
  'docs.css': 'text/css',
  'docs.js': 'text/javascript',
  'docs-theme.js': 'text/javascript',
  'assets/session-transcript.webp': 'image/webp',
  'assets/session-chat.webp': 'image/webp',
  'assets/landing-hero.webp': 'image/webp',
};

test.beforeEach(async ({ page }) => {
  // Serve the GitHub Pages tree separately from the app, using the existing browser runner.
  await page.route('**/handbook/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice('/handbook/'.length) || 'index.html';
    if (!Object.hasOwn(contentTypes, name)) {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      contentType: contentTypes[name],
      body: await readFile(resolve(docsRoot, name)),
    });
  });
});

for (const width of [320, 390, 640, 760, 768, 1440]) {
  test(`documentation navigation and deep links at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/handbook/');
    const menu = page.locator('#navigation');
    const nav = page.getByRole('navigation', { name: 'Documentation', exact: true });
    if (width <= 760) {
      await expect(menu).not.toHaveAttribute('open');
      const header = await page.locator('.site-header').boundingBox();
      const heading = await page.locator('#page-title').boundingBox();
      expect(header!.height).toBeLessThanOrEqual(64);
      expect(heading!.y).toBeLessThanOrEqual(180);
      for (const control of [
        page.getByRole('link', { name: 'GitHub', exact: true }),
        page.getByRole('link', { name: 'Open app', exact: true }),
        page.getByRole('button', { name: 'Switch to dark mode' }),
        menu.locator('summary'),
      ]) {
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      await menu.locator('summary').focus();
      await page.keyboard.press('Enter');
    }
    await nav.getByRole('link', { name: 'Quickstart', exact: true }).click();
    await expect(page).toHaveURL(/#quickstart$/);
    await expect(page.locator('#quickstart-title')).toBeInViewport();
    if (width <= 760) {
      await expect(menu).not.toHaveAttribute('open');
      await expect(page.locator('#quickstart')).toBeFocused();
    }
    await page.goto('/handbook/#recovery');
    await expect(page.locator('#recovery')).toBeInViewport();
    await page.reload();
    await expect(page.locator('#recovery')).toBeInViewport();
    if (width <= 760) {
      const recovery = await page.locator('#recovery').boundingBox();
      const sidebar = await page.locator('.sidebar').boundingBox();
      expect(recovery!.y).toBeGreaterThanOrEqual(sidebar!.y + sidebar!.height);
    }
    await expect(page.getByRole('link', { name: 'Open app', exact: true }))
      .toHaveAttribute('href', 'https://useweft.netlify.app');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(11, 17, 25)');
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 248, 250)');
    for (const theme of ['dark', 'light']) {
      await page.getByRole('button', { name: `Switch to ${theme} mode` }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.reload();
      await expect(page.getByRole('button', { name: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode` })).toBeVisible();
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(violations).toEqual([]);
    }
  });
}

test.describe('documentation without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the native menu and handbook remain usable', async ({ page }) => {
    await page.goto('/handbook/');
    await expect(page.locator('#navigation')).toHaveAttribute('open');
    await page.getByRole('navigation', { name: 'Documentation', exact: true })
      .getByRole('link', { name: 'Command reference', exact: true }).click();
    await expect(page).toHaveURL(/#commands$/);
    await expect(page.locator('#commands-title')).toBeInViewport();
    await expect(page.locator('#commands')).toContainText('weft start --new-device');
  });
});
