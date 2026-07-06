import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const HTML = 'C:\\Users\\akash\\weft\\design\\dossier.html';
const PDF = 'C:\\Users\\akash\\weft\\design\\Weft-Design-Dossier.pdf';
const ASSETS = 'C:\\Users\\akash\\weft\\design\\assets';

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });

await page.goto(pathToFileURL(HTML).href, { waitUntil: 'networkidle' });

// Wait for webfonts + every image to be fully decoded before printing.
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images).map((img) =>
      img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = r; }),
    ),
  );
});
await page.waitForTimeout(600);
console.log('• fonts + images ready');

await page.pdf({
  path: PDF,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
});
console.log('• pdf written →', PDF);

// High-res previews of a few signature pages to show inline.
const pages = await page.locator('.page').all();
const want = { 0: 'preview-cover', 1: 'preview-brief', 2: 'preview-arch', 3: 'preview-interface', 4: 'preview-multi', 5: 'preview-system', 6: 'preview-eng', 7: 'preview-back' };
for (const [i, name] of Object.entries(want)) {
  if (pages[i]) {
    await pages[i].screenshot({ path: `${ASSETS}\\${name}.png` });
    console.log('• preview', name);
  }
}

await browser.close();
console.log('done');
