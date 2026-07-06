import { chromium } from '@playwright/test';

const SITE = process.env.WEFT_URL || 'https://useweft.netlify.app/';
const OUT = 'C:\\Users\\akash\\weft\\design\\assets';

const browser = await chromium.launch();
const shot = async (fn, file) => {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await fn(page);
  await page.screenshot({ path: `${OUT}\\${file}` });
  console.log('•', file);
  await ctx.close();
};

const startDemo = async (page) => {
  await page.getByText('Demo / Simulator').click();
  await page.waitForSelector('.weft-session', { timeout: 15000 });
};

// 1) Pairing / onboarding screen (fresh load)
await shot(async (page) => {
  await page.waitForTimeout(1200);
}, 'pairing.png');

// 2) Chat hero — both inline tool cards done, markdown, before approval
await shot(async (page) => {
  await startDemo(page);
  await page.waitForTimeout(6800);
}, 'chat.png');

// 3) Tool card expanded (args + result)
await shot(async (page) => {
  await startDemo(page);
  await page.waitForSelector('.tc-head', { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.locator('.tc-head').first().click();
  await page.waitForTimeout(500);
}, 'tool.png');

// 4) Approval flow — banner visible in the dock
await shot(async (page) => {
  await startDemo(page);
  await page.waitForSelector('.approval-banner', { timeout: 15000 });
  await page.waitForTimeout(400);
}, 'approval.png');

// 5) Multi-session drawer (with the approval tag on the row)
await shot(async (page) => {
  await startDemo(page);
  await page.waitForSelector('.approval-banner', { timeout: 15000 });
  await page.locator('.drawer-btn').click();
  await page.waitForTimeout(600);
}, 'drawer.png');

await browser.close();
console.log('done →', OUT);
