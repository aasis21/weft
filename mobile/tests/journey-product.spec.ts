import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const layouts = [
  { name: 'small phone', width: 320, height: 740, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'laptop', width: 1440, height: 900, touch: false },
];

test('homepage theme choice persists and follows the system when requested', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const theme = page.getByRole('combobox', { name: 'Theme' });
  await expect(theme).toBeEnabled();
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(theme).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await theme.selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await theme.selectOption('system');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(10, 14, 20)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await theme.selectOption('dark');
  await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.locator('.weft-session')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('setup deep links work after app mount and large text reflows', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#get-started');
  await expect(page.getByRole('heading', { name: 'From your terminal to your phone.' })).toBeInViewport();
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const overflowingCards = await page.locator('.step-card, .do-card').evaluateAll(
    (cards) => cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length,
  );
  expect(overflowingCards).toBe(0);
});

for (const layout of layouts) {
  test.describe(`Product site: ${layout.name}`, () => {
    test.use({
      viewport: { width: layout.width, height: layout.height },
      isMobile: layout.touch,
      hasTouch: layout.touch,
      deviceScaleFactor: 1,
    });

    for (const colorScheme of ['light', 'dark'] as const) {
      test(`responsive navigation, setup and accessibility in ${colorScheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.goto('/');
        const hero = page.locator('.landing-hero');
        await expect(hero).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Product navigation' }).getByRole('link', { name: 'Docs' }))
          .toHaveAttribute('href', 'https://aasis21.github.io/weft/');
        if (layout.touch) {
          await expect(hero.getByRole('button', { name: 'Scan QR to pair' })).toHaveClass('primary-action');
          await expect(hero.getByRole('link', { name: 'Set up your laptop' })).toHaveCount(0);
        } else {
          await hero.getByRole('link', { name: 'Set up your laptop' }).click();
          await expect(page).toHaveURL(/#get-started$/);
          await expect(page.getByRole('heading', { name: 'Install on your laptop' })).toBeInViewport();
        }

        await page.getByRole('tab', { name: 'Windows' }).click();
        await page.keyboard.press('ArrowRight');
        await expect(page.getByRole('tab', { name: 'macOS · Linux' })).toBeFocused();
        await expect(page.getByRole('tabpanel')).toContainText('curl -fsSL');
        await page.getByText('What do I need to get started?', { exact: true }).click();
        await expect(page.locator('.product-faq details[open]')).toContainText('Node.js 20+');
        await expect(page.locator('.product-faq summary')).toHaveCount(3);
        await page.getByText('Where does my work run? Can I leave my desk?', { exact: true }).click();
        await page.getByText('Who can see or control my session?', { exact: true }).click();
        await expect(page.locator('.product-faq')).toContainText('Keep the laptop awake');
        await expect(page.locator('.product-faq')).toContainText('own service policies');
        await expect(page.getByRole('link', { name: 'Get help reconnecting a phone.' }))
          .toHaveAttribute('href', 'https://aasis21.github.io/weft/#recovery');

        const overflow = await page.evaluate(() => {
          const shell = document.querySelector('.landing-shell')!;
          return [...shell.querySelectorAll<HTMLElement>('section, nav, pre, .step-card, .do-card')]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => el.className);
        });
        expect(overflow).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        expect(violations).toEqual([]);
      });
    }

    test('pairing and demo remain reachable', async ({ page }) => {
      await page.goto('/');
      await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();
      await expect(page.getByRole('heading', { name: 'Scan to connect' })).toBeVisible();
      await page.getByRole('button', { name: '← Back', exact: true }).click();
      await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
      await expect(page.locator('.weft-session')).toBeVisible();
    });
  });
}
