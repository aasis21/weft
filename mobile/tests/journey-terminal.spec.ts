import { test, expect } from '@playwright/test';

for (const layout of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`shared terminal demo: ${layout.name}, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(layout);
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
      await expect(page.locator('.weft-session')).toBeVisible();
      if (layout.width < 1024) await page.locator('.drawer-btn').click();
      await page.getByRole('button', { name: /Demo laptop/ }).first().click();
      const actions = page.locator('.device-action-grid > button');
      await expect(actions).toHaveCount(5);
      const actionBounds = await actions.evaluateAll((buttons) =>
        buttons.map((button) => {
          const { top, width, height } = button.getBoundingClientRect();
          return { top, width, height };
        }),
      );
      const actionRows = new Map<number, number>();
      for (const { top } of actionBounds) {
        const row = Math.round(top);
        actionRows.set(row, (actionRows.get(row) ?? 0) + 1);
      }
      expect([...actionRows.values()]).toEqual([3, 2]);
      expect(actionBounds.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
      await page.locator('.device-quick-actions').screenshot({ path: testInfo.outputPath('quick-actions.png') });
      await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
      await expect(page.getByRole('main', { name: 'Shared terminal' })).toBeVisible();
      await expect(page.getByText('You have control', { exact: true })).toBeVisible();
      await expect(page.locator('.xterm-screen')).toBeVisible();
      const command = page.getByLabel('Command', { exact: true });
      await command.fill('echo PHONE_PRIVATE_SENTINEL');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(command).toHaveValue('');
      await expect(page.locator('.xterm-accessibility-tree')).toContainText('PHONE_PRIVATE_SENTINEL');
      await page.getByRole('button', { name: 'Previous command' }).click();
      await expect(command).toHaveValue('echo PHONE_PRIVATE_SENTINEL');
      await command.fill('');
      await page.getByRole('button', { name: 'Direct typing' }).click();
      await page.keyboard.type('echo direct-input');
      await page.getByRole('button', { name: 'Enter', exact: true }).click();
      await expect(page.locator('.xterm-accessibility-tree')).toContainText('direct-input');
      await page.getByRole('button', { name: 'Back to device' }).click();
      await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
      await expect(page.getByText('You have control', { exact: true })).toBeVisible();
      await expect(command).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Previous command' })).toBeDisabled();
      await command.fill('laptop');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.getByText('Laptop has control', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Take control' }).click();
      await expect(page.getByText('You have control', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Fit to phone' }).click();
      await command.fill('stream');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(command).toHaveValue('');
      await expect(page.locator('.xterm-accessibility-tree')).toContainText('Output line 80');
      await page.locator('.xterm-screen').hover();
      await page.mouse.wheel(0, -2000);
      await expect(page.getByRole('button', { name: 'Return to latest output' })).toBeVisible();
      const firstVisibleRow = await page.locator('.xterm-accessibility-tree').evaluate(async (tree) => {
        let previous = '';
        let settledFrames = 0;
        for (let frame = 0; frame < 120; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const current = tree.firstElementChild?.textContent ?? '';
          settledFrames = current === previous ? settledFrames + 1 : 0;
          if (settledFrames >= 6) return current;
          previous = current;
        }
        throw new Error('Terminal wheel scrolling did not settle.');
      });
      await command.fill('echo while-reading');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(command).toHaveValue('');
      await command.fill('next draft');
      await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
      await expect(page.locator('.xterm-accessibility-tree > div').first()).toHaveText(firstVisibleRow!);
      await expect(page.getByRole('button', { name: 'Return to latest output' })).toBeVisible();
      await page.getByRole('button', { name: 'Return to latest output' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('PHONE_PRIVATE_SENTINEL');
      await page.screenshot({ path: testInfo.outputPath('terminal.png') });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Close terminal?' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
      await expect(page.getByText('Shell closed', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open new terminal' }).click();
      await expect(page.getByText('You have control', { exact: true })).toBeVisible();
    });
  }
}
