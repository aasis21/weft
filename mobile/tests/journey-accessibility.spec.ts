import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';

const KNOWN_VIOLATIONS = {
  'Landing surface': new Set([
    'color-contrast::#install-tab-windows',
    'meta-viewport::meta[name="viewport"]',
  ]),
  'Active-session surface': new Set([
    'color-contrast::.cwd-chip',
    'meta-viewport::meta[name="viewport"]',
  ]),
} as const;

type Surface = keyof typeof KNOWN_VIOLATIONS;

interface AxeFinding {
  key: string;
  rule: Result;
  target: string;
  html: string;
  failureSummary: string | undefined;
}

function flattenViolations(violations: Result[]): AxeFinding[] {
  return violations.flatMap((rule) =>
    rule.nodes.map((node) => {
      const target = node.target.map(String).join(' > ');
      return {
        key: `${rule.id}::${target}`,
        rule,
        target,
        html: node.html,
        failureSummary: node.failureSummary,
      };
    }),
  );
}

function formatFindings(surface: Surface, findings: AxeFinding[]): string {
  const details = findings.flatMap(({ rule, target, html, failureSummary }) => [
    `[${rule.impact ?? 'unknown'}] ${rule.id}: ${rule.help}`,
    `  ${rule.helpUrl}`,
    `  Target: ${target}`,
    `  HTML: ${html}`,
    `  ${failureSummary ?? 'Review the affected element against the linked rule.'}`,
  ]);

  return `${surface} has ${findings.length} new accessibility violation(s):\n${details.join('\n')}`;
}

async function expectNoAccessibilityViolations(
  page: import('@playwright/test').Page,
  surface: Surface,
): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const findings = flattenViolations(violations);
  const expectedKnown = [...KNOWN_VIOLATIONS[surface]].sort();
  const observedKnown = findings
    .map((finding) => finding.key)
    .filter((key) => KNOWN_VIOLATIONS[surface].has(key))
    .sort();
  const unexpected = findings.filter((finding) => !KNOWN_VIOLATIONS[surface].has(finding.key));

  expect(unexpected.length, formatFindings(surface, unexpected)).toBe(0);
  expect(
    observedKnown,
    `${surface} accessibility baseline changed; remove resolved entries or investigate missing coverage.`,
  ).toEqual(expectedKnown);
}

test.describe('Journey: accessibility', () => {
  test('the landing surface has no new automated WCAG A or AA violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.landing-shell')).toBeVisible();

    await expectNoAccessibilityViolations(page, 'Landing surface');
  });

  test('the active-session surface has no new automated WCAG A or AA violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();
    await expect(page.locator('.weft-session')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message your Copilot session' })).toBeVisible();

    await expectNoAccessibilityViolations(page, 'Active-session surface');
  });

  test('the landing and connect screens expose named controls and landmarks', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Your Copilot session, now in your hand.',
    );

    const tablist = page.getByRole('tablist', { name: 'Operating system' });
    const windows = tablist.getByRole('tab', { name: 'Windows' });
    const unix = tablist.getByRole('tab', { name: 'macOS · Linux' });
    const panel = page.getByRole('tabpanel');
    await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(1);

    const nextTab = (await windows.getAttribute('aria-selected')) === 'true' ? unix : windows;
    await nextTab.click();
    await expect(nextTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveAttribute('aria-labelledby', await nextTab.getAttribute('id') ?? '');

    await page.locator('.landing-hero').getByRole('button', { name: 'Scan QR to pair' }).click();
    await expect(page.getByRole('heading', { name: 'Scan to connect', level: 2 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Scan pairing QR' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  });

  test('the session drawer traps focus, closes with Escape, and restores its trigger', async ({ page }) => {
    await page.goto('/');
    await page.locator('.landing-hero').getByRole('button', { name: 'Try the demo' }).click();

    const openSessions = page.getByRole('button', { name: 'Open sessions' });
    await expect(openSessions).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message your Copilot session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start another session' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan to join a session' })).toBeVisible();

    // Safari/WebKit does not focus buttons on pointer click. Open from the keyboard so focus
    // restoration is tested against the actual accessible activation path in every browser.
    await openSessions.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Weft' });
    const close = drawer.getByTitle('Close');
    await expect(drawer).toBeVisible();
    await expect(close).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(drawer.getByRole('button', { name: 'About Weft' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(openSessions).toBeFocused();
  });
});
