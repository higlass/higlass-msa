// Importance-based label thinning, driven with real input events in Chrome.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

import { rowName } from '../src/synthetic/field.js';

const OUT = 'spike-output';
const WIDTH = 2000;
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { port: 5193 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const isLong = (row) => rowName(row).length > 30;

async function settle() {
  await page.waitForFunction(
    () => {
      const t = window.__msaTrack;
      return t?.tilesetInfo && t.visibleTileIds.size > 0 && t.areAllVisibleTilesLoaded() && t.fetching.size === 0;
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(250);
}

const labels = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const spriteY = t.labelSprite.worldTransform.ty;
    return {
      rowPx: t.rowPx,
      box: t.labelBox,
      list: t.labelRows.map((r) => ({ row: r.row, worldY: spriteY + r.y })),
    };
  });

async function tick(delta) {
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(40);
  return labels();
}

const check = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

const share = (s) => s.list.filter((l) => isLong(l.row)).length / s.list.length;

await page.goto(`${server.resolvedUrls.local[0]}?columns=1000000&rows=1000&rowHeight=1&height=1000`);
await page.waitForFunction(() => window.__msaReady);
await settle();

let far;
await check('zoomed out, the labels shown are the long names', async () => {
  far = await labels();
  assert.equal(far.rowPx, 1);
  console.log(`   at 1 px: ${far.list.length} labels, ${(share(far) * 100).toFixed(0)}% long`);
  assert.ok(far.list.length >= 30, `${far.list.length} labels`);
  assert.ok(share(far) >= 0.9, `share ${share(far)}`);
  await page.screenshot({ path: `${OUT}/importance-1-zoomed-out.png` });
});

await check('a zoom sweep only adds going in, with no overlap', async () => {
  await page.mouse.move(WIDTH / 2, 500);
  await page.keyboard.down('Shift');
  const noOverlap = (s) => {
    for (let i = 1; i < s.list.length; i++) {
      assert.ok(s.list[i].worldY - s.list[i - 1].worldY >= s.box - 1e-6, `rowPx ${s.rowPx}`);
    }
  };
  // Row 0 stays at the top with the cursor at mid-track, so compare rows on screen in both.
  let prev = await labels();
  for (let i = 0; i < 14; i++) {
    const s = await tick(-120);
    noOverlap(s);
    const rows = new Set(s.list.map((l) => l.row));
    const lo = s.list[0].row;
    const hi = s.list.at(-1).row;
    for (const l of prev.list) {
      if (l.row > lo && l.row < hi) assert.ok(rows.has(l.row), `row ${l.row} vanished going in`);
    }
    prev = s;
  }
  assert.ok(prev.rowPx >= 10);
  await page.screenshot({ path: `${OUT}/importance-2-zoomed-in.png` });
  for (let i = 0; i < 20; i++) {
    const s = await tick(120);
    noOverlap(s);
    prev = s;
  }
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
});

await check('returning to the start shows mostly the same labels', async () => {
  const back = await labels();
  const start = new Set(far.list.map((l) => l.row));
  const same = back.list.filter((l) => start.has(l.row)).length;
  console.log(`   ${same} of ${far.list.length} starting labels came back, ${back.list.length} showing`);
  assert.ok(same / far.list.length >= 0.5, `${same} of ${far.list.length}`);
  assert.ok(share(back) >= 0.9, `share ${share(back)}`);
});

await check('switching importance off stops favoring long names', async () => {
  await page.evaluate(() => {
    const t = window.__msaTrack;
    t.rerender({ ...t.options, rowLabelImportance: 'none' }, true);
    t.animate();
  });
  const s = await labels();
  assert.ok(share(s) < 0.3, `share ${share(s)}`);
});

assert.deepEqual(errors, []);
console.log('\nimportance browser checks passed');
await browser.close();
await server.close();
