// Captures the same stretch of alignment at a sweep of zoom levels, so the colors
// and the resolution steps can be compared side by side.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const OUT = process.argv[2];
const WIDTH = 1600;
const HEIGHT = 700;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5207 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));

const settle = () =>
  page
    .waitForFunction(
      () => {
        const t = window.__msaTrack;
        return t?.tilesetInfo && t.visibleTileIds.size > 0 && t.areAllVisibleTilesLoaded() && t.fetching.size === 0;
      },
      null,
      { timeout: 120000 },
    )
    .then(() => page.waitForTimeout(400));

await page.goto(`${server.resolvedUrls.local[0]}?columns=1000000&rows=512&rowHeight=1&height=512`);
await page.waitForFunction(() => window.__msaReady);
await settle();

const CENTER = 500000;
const spans = [1000000, 250000, 60000, 16000, 4000, 1000, 250, 60];
for (const span of spans) {
  await page.evaluate(
    ([c, s]) => window.hgApi.zoomTo('main', c - s / 2, c + s / 2, c - s / 2, c + s / 2, 0),
    [CENTER, span],
  );
  await settle();
  const info = await page.evaluate(() => {
    const t = window.__msaTrack;
    const tiles = Object.values(t.fetchedTiles).filter((x) => x.msaMesh);
    const u = tiles.map((x) => ({
      kind: x.tileData.kind,
      res: x.tileData.resolution,
      emphasis: x.msaMesh.shader.uniforms.uEmphasis,
      smooth: x.msaMesh.shader.uniforms.uSmooth,
      letters: x.msaMesh.shader.uniforms.uLetterAlpha,
    }));
    const [a, b] = t._xScale.domain();
    return { span: Math.round(b - a), levels: [...new Set(u.map((x) => `${x.kind}/${x.res}`))], u: u[0] };
  });
  console.log(String(span).padStart(8), JSON.stringify(info));
  const box = await page.evaluate(() => {
    const t = window.__msaTrack;
    return { x: t.position[0], y: t.position[1], width: t.dimensions[0], height: t.dimensions[1] };
  });
  await page.screenshot({ path: `${OUT}/span-${String(span).padStart(8, '0')}.png`, clip: box });
}

await browser.close();
await server.close();
