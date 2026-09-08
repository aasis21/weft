import { test, expect } from '@playwright/test';

for (const layout of [
  { name: 'small-phone', width: 320, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-keyboard-height', width: 390, height: 420 },
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
      await expect(command).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
      const outputBounds = await page.locator('.terminal-display').boundingBox();
      expect(outputBounds!.height).toBeGreaterThan(layout.height >= 640 ? layout.height * .5 : 100);
      const keyBounds = await page.getByRole('toolbar', { name: 'Terminal special keys' }).locator('button')
        .evaluateAll((buttons) => buttons.map((button) => {
          const { left, right, bottom, width, height } = button.getBoundingClientRect();
          return { left, right, bottom, width, height };
        }));
      expect(keyBounds).toHaveLength(8);
      expect(keyBounds.every((key) => key.left >= 0 && key.right <= layout.width &&
        key.bottom <= layout.height && key.width >= 44 && key.height >= 44)).toBe(true);
      await expect.poll(() => page.locator('.terminal-pan').evaluate((pan) => pan.scrollWidth - pan.clientWidth))
        .toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath('terminal-first.png') });
      await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
      await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
      if (layout.name === 'phone') {
        await page.setViewportSize({ width: layout.width, height: 420 });
        await expect.poll(() => page.locator('.terminal-screen').evaluate((root) => root.getBoundingClientRect().height))
          .toBe(420);
        await expect.poll(() => page.locator('.terminal-actions').evaluate((actions) => actions.getBoundingClientRect().bottom))
          .toBeLessThanOrEqual(420);
        await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
        await page.setViewportSize(layout);
      }
      await page.locator('.terminal-host').evaluate((host) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', 'echo PHONE_PRIVATE_SENTINEL');
        host.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await expect(command).toHaveValue('echo PHONE_PRIVATE_SENTINEL');
      await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('PHONE_PRIVATE_SENTINEL');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(command).toHaveValue('');
      await expect(page.locator('.xterm-accessibility-tree')).toContainText('PHONE_PRIVATE_SENTINEL');
      await command.fill('draft to keep');
      await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
      await expect(command).toHaveCount(0);
      await page.keyboard.type('echo direct-input');
      await page.getByRole('button', { name: 'Enter', exact: true }).click();
      await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
      await expect(page.locator('.xterm-accessibility-tree')).toContainText('direct-input');
      await page.getByRole('button', { name: 'Write / paste' }).click();
      await expect(command).toHaveValue('draft to keep');
      await page.getByRole('button', { name: 'Back to device' }).click();
      await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
      await expect(page.getByText('You have control', { exact: true })).toBeVisible();
      await expect(command).toHaveCount(0);
      await page.getByRole('button', { name: 'Write / paste' }).click();
      await expect(command).toHaveValue('');
      await command.fill('laptop');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.getByText('Laptop has control', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Keyboard', exact: true })).toBeDisabled();
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
      await page.getByRole('button', { name: 'Write / paste' }).click();
      await expect(command).toHaveCount(0);
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
