import { test, expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

async function labelOffset(row: Locator): Promise<number> {
  const box = await row.locator('.workspace-entry-name').boundingBox();
  expect(box).not.toBeNull();
  return box!.x;
}

async function expectEntryIcon(row: Locator, kind: 'folder' | 'file'): Promise<void> {
  const icon = row.locator(`.workspace-${kind}-icon`);
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  const box = await icon.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBe(18);
  expect(await labelOffset(row)).toBeGreaterThanOrEqual(box!.x + box!.width);
  const rowBox = await row.boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);
}

test('Files, chat file links, and Changes use the same on-demand viewer', async ({ page }) => {
  await page.goto('/');
  await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.locator('.status-title')).toContainText('Demo session');
  await page.getByRole('button', { name: 'Demo report', exact: true }).click();
  const direct = page.locator('.workspace-screen');
  await expect(direct.frameLocator('iframe').getByRole('heading', { name: 'Demo report' })).toBeVisible();
  await direct.getByRole('button', { name: '‹ Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Files', exact: true }).locator('svg')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Changes', exact: true }).locator('svg')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
  const workspace = page.locator('.workspace-screen');
  await expect(workspace).toBeVisible();
  const current = workspace.getByRole('region', { name: 'Current folder' });
  const touched = workspace.getByRole('region', { name: 'Agent-touched files' });
  await expect(current).toBeVisible();
  await expect(touched).toBeVisible();
  await current.getByRole('button', { name: 'reports', exact: true }).click();
  await current.getByRole('button', { name: 'reports/summary.html', exact: true }).click();
  await expect(workspace.locator('iframe')).toBeVisible();
  await expect(workspace.frameLocator('iframe').getByRole('heading', { name: 'Demo report' })).toBeVisible();
  await expect(workspace.locator('iframe')).toHaveAttribute('sandbox', '');
  await workspace.getByRole('button', { name: '‹ Files', exact: true }).click();
  await touched.getByRole('button', { name: 'README.md', exact: true }).click();
  await workspace.getByRole('button', { name: 'report', exact: true }).click();
  await expect(workspace.frameLocator('iframe').getByRole('heading', { name: 'Demo report' })).toBeVisible();
  await workspace.getByRole('button', { name: '‹ Files', exact: true }).click();
  await current.getByRole('button', { name: 'docs', exact: true }).click();
  await current.getByRole('button', { name: 'docs/guide.md', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: 'Workspace guide' })).toBeVisible();
  await workspace.getByRole('button', { name: '‹ Files', exact: true }).click();
  await expect(touched.getByRole('button', { name: 'docs/guide.md', exact: true })).toHaveCount(0);
  let external = touched;
  for (const folder of ['Outside workspace', 'C:', 'Users', 'demo', 'reports']) {
    const button = external.getByRole('button', { name: folder, exact: true });
    await button.click();
    external = button.locator('..');
  }
  await external.getByRole('button', { name: 'C:\\Users\\demo\\reports\\outside.md', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: 'Outside workspace', exact: true })).toBeVisible();
  await expect(workspace.getByText('outside.md', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '‹ Files', exact: true }).click();
  await workspace.getByRole('button', { name: '‹ Chat', exact: true }).click();
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Changes', exact: true }).click();
  await workspace.getByRole('button', { name: /M src\/app.ts/ }).click();
  await expect(workspace.locator('.workspace-diff')).toContainText('-export const version = 1');
  await expect(workspace.locator('.workspace-diff')).toContainText('+export const version = 2');
  await expect(workspace.locator('.workspace-diff .insert')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [320, 412]) {
  test(`file icons and hierarchy remain clear at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 915 });
    await page.emulateMedia({ colorScheme: width === 320 ? 'light' : 'dark' });
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.status-title')).toContainText('Demo session');
    await page.getByRole('button', { name: 'Session menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    const workspace = page.locator('.workspace-screen');
    const current = workspace.getByRole('region', { name: 'Current folder' });
    const touched = workspace.getByRole('region', { name: 'Agent-touched files' });
    const root = current.locator('.workspace-tree-root');
    const folder = current.getByRole('button', { name: 'docs', exact: true });
    await expect(folder).toBeEnabled();
    await expectEntryIcon(root, 'folder');
    expect(await workspace.evaluate((main) => {
      const style = getComputedStyle(main);
      const luminance = (color: string): number => {
        const channels = color.match(/\d+/g)!.slice(0, 3).map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const fg = luminance(style.color), bg = luminance(style.backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    })).toBeGreaterThanOrEqual(4.5);
    await expectEntryIcon(folder, 'folder');
    expect(await labelOffset(folder)).toBeGreaterThanOrEqual(await labelOffset(root) + 16);
    await folder.click();
    const file = current.getByRole('button', { name: 'docs/guide.md', exact: true });
    await expect(file).toBeEnabled();
    await expectEntryIcon(file, 'file');
    expect(await labelOffset(file)).toBeGreaterThanOrEqual(await labelOffset(folder) + 16);
    expect(await file.locator('..').locator('..').evaluate((list) => getComputedStyle(list).borderInlineStartWidth)).toBe('1px');
    await expect(workspace.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await workspace.screenshot({ path: testInfo.outputPath(`current-folder-${width}.png`) });
    await file.click();
    await expect(workspace.getByRole('heading', { name: 'Workspace guide' })).toBeVisible();
    await workspace.getByRole('button', { name: '‹ Files', exact: true }).click();
    await expect(current.getByRole('button', { name: 'docs', exact: true })).toHaveAttribute('aria-expanded', 'true');
    const externalFolder = touched.getByRole('button', { name: 'Outside workspace', exact: true });
    const startingOffset = await labelOffset(externalFolder);
    let branch: Locator = touched, previousOffset = startingOffset - 16;
    for (const name of ['Outside workspace', 'C:', 'Users', 'demo', 'reports']) {
      const row = branch.getByRole('button', { name, exact: true });
      await expectEntryIcon(row, 'folder');
      const offset = await labelOffset(row);
      expect(offset).toBeGreaterThanOrEqual(previousOffset + 16);
      previousOffset = offset;
      await row.click();
      branch = row.locator('..');
    }
    const outside = branch.getByRole('button', { name: 'C:\\Users\\demo\\reports\\outside.md', exact: true });
    await expectEntryIcon(outside, 'file');
    expect(await labelOffset(outside)).toBeGreaterThanOrEqual(previousOffset + 16);
    expect(await page.evaluate(() => {
      const main = document.querySelector('.workspace-screen')!;
      const scroller = main.querySelector('.workspace-content')!;
      return document.documentElement.scrollWidth <= innerWidth &&
        scroller.scrollWidth <= scroller.clientWidth &&
        [...main.querySelectorAll('.workspace-entry-name')].every((label) => {
          const box = label.getBoundingClientRect();
          return box.right <= innerWidth && label.scrollWidth <= label.clientWidth + 1;
        });
    })).toBe(true);
    await externalFolder.scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: testInfo.outputPath(`agent-touched-${width}.png`) });
  });
}
