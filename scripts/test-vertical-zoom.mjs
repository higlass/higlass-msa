// Drives shift+wheel and shift+drag with real input events in Chrome.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const OUT = 'spike-output';
const WIDTH = 2000;
const HEIGHT = 1100;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5198 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const CENTER_X = WIDTH / 2;

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

const state = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const raw = Object.values(t.fetchedTiles).filter((x) => x.msaMesh && x.tileData.kind === 'raw');
    // The track's own scale: hgApi.getLocation stays stale after zoomTo.
    const [a, b] = t._xScale.domain();
    return {
      k: t.rowView.k,
      offset: t.rowView.offset,
      rowPx: t.rowPx,
      span: b - a,
      xDomain: [a, b],
      blocks: [...new Set([...t.visibleTileIds].map((id) => +id.split('.')[2]))].sort((x, y) => x - y),
      letterAlpha: raw.length ? Math.max(...raw.map((x) => x.msaMesh.shader.uniforms.uLetterAlpha)) : null,
    };
  });

async function wheel(n, deltaY, { shift = false, y = 500 } = {}) {
  await page.mouse.move(CENTER_X, y);
  if (shift) await page.keyboard.down('Shift');
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(30);
  }
  if (shift) await page.keyboard.up('Shift');
  // d3-zoom ends a wheel gesture 150 ms after the last event, and a zoomTo sent
  // before then is lost.
  await page.waitForTimeout(300);
}

async function shiftDrag(dY, y = 500) {
  await page.mouse.move(CENTER_X, y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(CENTER_X, y + (dY * i) / 10);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
}

/**
 * Where cells really land on the canvas, read from the mesh's final transform.
 * Compared with the track's own bounds and the x scale the axis uses.
 */
const onScreen = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const meshes = Object.values(t.fetchedTiles).filter((x) => x.msaMesh);
    const rows = t.tilesetInfo.shape[0];
    const blockRows = 256;
    const first = meshes.find((x) => x.tileData.rowBlock === 0);
    const lastBlock = Math.floor((rows - 1) / blockRows);
    const last = meshes.find((x) => x.tileData.rowBlock === lastBlock);
    const anyMesh = meshes[0];
    const m = anyMesh.msaMesh.worldTransform;
    return {
      trackTop: t.position[1],
      trackBottom: t.position[1] + t.dimensions[1],
      firstRowTop: first ? first.msaMesh.worldTransform.ty : null,
      lastRowBottom: last ? last.msaMesh.worldTransform.ty + last.msaMesh.worldTransform.d : null,
      tileLeft: m.tx,
      expectedTileLeft: t.position[0] + t._xScale(anyMesh.tileData.startColumn),
    };
  });

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

await page.goto(`${server.resolvedUrls.local[0]}?columns=1000000&rows=1000&rowHeight=1&height=1000`);
await page.waitForFunction(() => window.__msaReady);
await settle();

await check('at rest, row 0 starts at the track top and columns line up with the axis', async () => {
  const s = await onScreen();
  assert.ok(Math.abs(s.firstRowTop - s.trackTop) < 0.01, `row 0 top ${s.firstRowTop}, track top ${s.trackTop}`);
  assert.ok(Math.abs(s.lastRowBottom - s.trackBottom) < 0.01, `last row ${s.lastRowBottom}, track bottom ${s.trackBottom}`);
  assert.ok(Math.abs(s.tileLeft - s.expectedTileLeft) < 0.01, `tile x ${s.tileLeft}, axis x ${s.expectedTileLeft}`);
});

await check('plain wheel zooms x only', async () => {
  const before = await state();
  await wheel(3, -120);
  const after = await state();
  assert.ok(after.span < before.span);
  assert.equal(after.k, 1);
  await wheel(3, 120);
});

await check('shift+wheel enlarges rows without changing x', async () => {
  const before = await state();
  await wheel(5, -120, { shift: true });
  const after = await state();
  assert.ok(after.k > 1, `k=${after.k}`);
  assert.deepEqual(after.xDomain, before.xDomain);
});

await check('zoom keeps the row under the cursor in place', async () => {
  // Page y of the track's top edge, measured rather than assumed.
  const top = await page.evaluate(
    () => window.__msaRenderer.view.getBoundingClientRect().top + window.__msaTrack.position[1],
  );
  const yInTrack = 300;
  const start = await state();
  const rowBefore = (yInTrack - start.offset) / start.rowPx;
  await wheel(3, -120, { shift: true, y: top + yInTrack });
  const end = await state();
  const rowAfter = (yInTrack - end.offset) / end.rowPx;
  assert.ok(end.k > start.k);
  assert.ok(Math.abs(rowAfter - rowBefore) < 0.01, `top=${top} ${rowBefore} -> ${rowAfter}`);
});

await check('x zoom carries on from where it was after a shift zoom', async () => {
  await wheel(10, -120);
  const zoomedX = await state();
  await wheel(3, -120, { shift: true });
  await wheel(3, 120, { shift: true });
  const afterShift = await state();
  assert.deepEqual(afterShift.xDomain, zoomedX.xDomain);
  await wheel(2, -120);
  const further = await state();
  assert.ok(further.span < zoomedX.span);
  assert.ok(further.span > zoomedX.span / 4, `${zoomedX.span} -> ${further.span}`);
  await page.evaluate(() => window.hgApi.zoomTo('main', 0, 1000000, 0, 1000000, 0));
  await page.waitForTimeout(200);
  await settle();
});

await check('shift+wheel out returns to k=1 at the top', async () => {
  await wheel(40, 120, { shift: true });
  const s = await state();
  assert.equal(s.k, 1);
  assert.equal(s.offset, 0);
});

await check('shift+wheel works in both directions at the widest x limit', async () => {
  // Wheel to the limit: zoomTo lands a rounding error away, which would hide the bug.
  await wheel(40, 120);
  const widest = await state();
  assert.ok(Math.abs(widest.span - 1000000) < 1e-6, `span=${widest.span}`);
  assert.equal(
    await page.evaluate(() => {
      const el = document.querySelector('.track-renderer-element, [class*="track-renderer-element"]');
      return el?.__zoom?.k ?? null;
    }),
    1,
    'x zoom should be exactly at its lower limit',
  );
  await wheel(6, -120, { shift: true });
  const zoomedIn = await state();
  assert.ok(zoomedIn.k > 1);
  await wheel(3, 120, { shift: true });
  const partway = await state();
  assert.ok(partway.k < zoomedIn.k && partway.k > 1, `${zoomedIn.k} -> ${partway.k}`);
  await wheel(10, 120, { shift: true });
  const end = await state();
  assert.equal(end.k, 1);
  assert.deepEqual(end.xDomain, widest.xDomain);
});

await check('shift+wheel works in both directions at the narrowest x limit', async () => {
  await wheel(70, -120);
  const narrowest = await state();
  assert.ok(Math.abs(narrowest.span - 20) < 1e-6, `span=${narrowest.span}`);
  assert.equal(narrowest.k, 1);
  await wheel(25, -120, { shift: true });
  await settle();
  const zoomedIn = await state();
  assert.ok(zoomedIn.k > 1);
  assert.equal(zoomedIn.letterAlpha, 1);
  await wheel(40, 120, { shift: true });
  await settle();
  const zoomedOut = await state();
  assert.equal(zoomedOut.k, 1);
  assert.equal(zoomedOut.letterAlpha, 0);
  await page.evaluate(() => window.hgApi.zoomTo('main', 0, 1000000, 0, 1000000, 0));
  await page.waitForTimeout(200);
  await settle();
});

await check('shift+wheel outside the MSA track does not zoom its rows', async () => {
  const before = await state();
  const top = await page.evaluate(
    () => window.__msaRenderer.view.getBoundingClientRect().top + window.__msaTrack.position[1],
  );
  await wheel(4, -120, { shift: true, y: top - 10 });
  assert.equal((await state()).k, before.k);
});

await check('tall rows with narrow columns show no letters', async () => {
  await page.evaluate(() => window.hgApi.zoomTo('main', 500000, 501000, 500000, 501000, 0));
  await page.waitForTimeout(200);
  await settle();
  await wheel(25, -120, { shift: true });
  await settle();
  const s = await state();
  assert.ok(s.rowPx >= 10, `rowPx=${s.rowPx}`);
  assert.ok(WIDTH / s.span < 7, `pxPerColumn=${WIDTH / s.span}`);
  assert.equal(s.letterAlpha, 0);
  await page.screenshot({ path: `${OUT}/vzoom-1-tall-rows-narrow-columns.png` });
});

await check('wide columns with short rows show no letters', async () => {
  await wheel(40, 120, { shift: true });
  await page.evaluate(() => window.hgApi.zoomTo('main', 500000, 500100, 500000, 500100, 0));
  await page.waitForTimeout(200);
  await settle();
  const s = await state();
  assert.equal(s.k, 1);
  assert.ok(WIDTH / s.span >= 10, `pxPerColumn=${WIDTH / s.span}`);
  assert.equal(s.letterAlpha, 0);
  await page.screenshot({ path: `${OUT}/vzoom-2-wide-columns-short-rows.png` });
});

await check('letters appear once rows are also tall enough', async () => {
  await wheel(25, -120, { shift: true });
  await settle();
  const s = await state();
  assert.ok(s.rowPx >= 10, `rowPx=${s.rowPx}`);
  assert.equal(s.letterAlpha, 1);
  await page.screenshot({ path: `${OUT}/vzoom-3-letters.png` });
});

await check('shift+drag scrolls rows by exactly the distance dragged', async () => {
  const before = await page.evaluate(() => window.__msaTrack.rowView.offset);
  await shiftDrag(-100);
  const after = await page.evaluate(() => window.__msaTrack.rowView.offset);
  assert.ok(Math.abs(after - before + 100) < 0.01, `offset ${before} -> ${after}`);
  await shiftDrag(100);
  await page.waitForTimeout(200);
});

await check('shift+drag pans rows, loads new row blocks, leaves x alone', async () => {
  const before = await state();
  await shiftDrag(-400);
  const after = await state();
  assert.ok(after.offset < before.offset, `${before.offset} -> ${after.offset}`);
  assert.deepEqual(after.xDomain, before.xDomain);
  await settle();
  await page.screenshot({ path: `${OUT}/vzoom-4-after-shift-drag.png` });
});

await check('row height stops at the maximum', async () => {
  await wheel(60, -120, { shift: true });
  const s = await state();
  assert.equal(s.rowPx, 48);
  await settle();
  await page.screenshot({ path: `${OUT}/vzoom-5-max-row-height.png` });
});

await check('panning to the bottom stops at the last row and shows it', async () => {
  for (let i = 0; i < 8; i++) await shiftDrag(-450);
  let s = await state();
  for (let i = 0; i < 120 && s.offset > -(1000 * s.rowPx - 1000); i++) {
    await shiftDrag(-450);
    s = await state();
  }
  assert.equal(s.offset, -(1000 * s.rowPx - 1000));
  assert.ok(s.blocks.includes(3), `blocks=${s.blocks}`);
  await settle();
  const screen = await onScreen();
  assert.ok(
    Math.abs(screen.lastRowBottom - screen.trackBottom) < 0.01,
    `last row ${screen.lastRowBottom}, track bottom ${screen.trackBottom}`,
  );
  await page.screenshot({ path: `${OUT}/vzoom-6-bottom.png` });
});

assert.deepEqual(errors, []);
console.log(`\n${results.length} browser checks passed`);
await browser.close();
await server.close();
