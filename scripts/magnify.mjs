// Blows up PNGs with hard pixel edges, so a smear can be told from a hard step.
import { chromium } from 'playwright-core';

const scale = Number(process.argv[2]);
const files = process.argv.slice(3);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const file of files) {
  await page.goto(`file://${file}`);
  const size = await page.evaluate(
    (s) => {
      const img = document.querySelector('img');
      document.body.style.margin = '0';
      img.style.imageRendering = 'pixelated';
      img.style.width = `${img.naturalWidth * s}px`;
      img.style.height = `${img.naturalHeight * s}px`;
      return { width: img.naturalWidth * s, height: img.naturalHeight * s };
    },
    scale,
  );
  await page.setViewportSize(size);
  await page.screenshot({ path: file.replace(/\.png$/, `-x${scale}.png`) });
}
await browser.close();
