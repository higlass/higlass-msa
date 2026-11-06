// Browser check: in an editable view, dragging the track's bottom handle resizes it.
// HiGlass 2.3.5's DraggableDiv reads this.state right after setState, so under React 18
// automatic batching it reports the old height and the drag does nothing. React 17 works.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const vite = await createServer({ server: { port: 5195 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5195/demo/?columns=10000&rows=50&height=100&editable=1');
  const settle = async () => {
    await page.waitForFunction(() => {
      const t = window.__msaTrack;
      return t?.tilesetInfo && t.visibleTileIds.size > 0 && t.areAllVisibleTilesLoaded() && t.fetching.size === 0;
    });
    await page.waitForTimeout(300);
  };
  await page.waitForFunction(() => window.__msaReady);
  await settle();

  const handles = await page.$$('[title="Resize track"]');
  const box = await handles[handles.length - 1].boundingBox();
  // Height the drawn rows cover: the bottom edge of the lowest tile mesh.
  const drawn = () =>
    page.evaluate(() => {
      const t = window.__msaTrack;
      const meshes = Object.values(t.fetchedTiles).map((tile) => tile.msaMesh).filter(Boolean);
      return {
        track: t.dimensions[1],
        rows: Math.max(...meshes.map((m) => m.position.y + m.scale.y)),
      };
    });
  const start = await drawn();
  assert.ok(Math.abs(start.rows - start.track) <= 1, `rows cover ${start.rows} px of ${start.track}`);
  const before = start.track;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + i * 10);
  await page.mouse.up();
  await page.waitForTimeout(300);
  await settle();
  const after = await page.evaluate(() => window.__msaTrack.dimensions[1]);

  assert.deepEqual(errors, []);
  assert.ok(Math.abs(after - (before + 100)) <= 2, `track height ${before} -> ${after}, expected +100`);
  const end = await drawn();
  assert.ok(Math.abs(end.rows - end.track) <= 1, `after resize rows cover ${end.rows} px of ${end.track}`);
  console.log(`ok: track height ${before} -> ${after}, rows fill ${start.rows} -> ${end.rows} px`);
} finally {
  await browser.close();
  await vite.close();
}
