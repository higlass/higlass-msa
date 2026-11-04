// Row labels and hover tooltips, driven with real input events in Chrome.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

import { rawTile, rowName } from '../src/synthetic/field.js';

const OUT = 'spike-output';
const WIDTH = 2000;
const HEIGHT = 1100;
const COLUMNS = 1000000;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5195 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

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

const origin = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const r = window.__msaRenderer.view.getBoundingClientRect();
    return { left: r.left + t.position[0], top: r.top + t.position[1], width: t.dimensions[0], height: t.dimensions[1] };
  });

async function wheel(n, deltaY, { shift = false } = {}) {
  await page.mouse.move(WIDTH / 2, 500);
  if (shift) await page.keyboard.down('Shift');
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(30);
  }
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
}

async function shiftDrag(dY) {
  await page.mouse.move(WIDTH / 2, 500);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(WIDTH / 2, 500 + (dY * i) / 10);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
}

const labels = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const spriteY = t.labelSprite.worldTransform.ty;
    return {
      layerVisible: t.labelLayer.visible,
      rowPx: t.rowPx,
      offset: t.rowView.offset,
      trackTop: t.position[1],
      trackLeft: t.position[0],
      stride: t.labelRows.length > 1 ? t.labelRows[1].row - t.labelRows[0].row : null,
      box: t.labelBox,
      spriteX: t.labelSprite.worldTransform.tx,
      list: t.labelRows.map((r) => ({ ...r, worldY: spriteY + r.y, worldX: t.labelSprite.worldTransform.tx })),
    };
  });

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

const zoomTo = async (a, b) => {
  await page.evaluate(([x, y]) => window.hgApi.zoomTo('main', x, y, x, y, 0), [a, b]);
  await page.waitForTimeout(250);
  await settle();
};

await page.goto(`${server.resolvedUrls.local[0]}?columns=${COLUMNS}&rows=1000&rowHeight=1&height=1000&labelImportance=none`);
await page.waitForFunction(() => window.__msaReady);
await settle();

const hoverText = async (x, y) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    return document.querySelector('.track-mouseover-menu')?.textContent ?? '';
  });
};

const assertNoOverlap = (s) => {
  for (let i = 1; i < s.list.length; i++) {
    const gap = s.list[i].worldY - s.list[i - 1].worldY;
    assert.ok(gap >= s.box - 1e-6, `rows ${s.list[i - 1].row}, ${s.list[i].row}: gap ${gap}, box ${s.box}`);
  }
};

await check('on 1 px rows, labels are thinned out and do not overlap', async () => {
  const s = await labels();
  assert.equal(s.rowPx, 1);
  assert.equal(s.layerVisible, true);
  assert.ok(s.list.length >= 60 && s.list.length <= 100, `${s.list.length} labels`);
  assert.equal(s.list[0].text, rowName(0));
  assertNoOverlap(s);
  await page.screenshot({ path: `${OUT}/labels-0-zoomed-out.png` });
});

await check('a text box fits each label height, so glyphs cannot touch', async () => {
  const fits = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return [8, 9, 10, 11, 12, 13, 14].map((font) => {
      ctx.font = `${font}px Menlo, Consolas, monospace`;
      ctx.textBaseline = 'middle';
      const m = ctx.measureText('Agjy|_[');
      return { font, glyph: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, box: font * 1.25 };
    });
  });
  for (const { font, glyph, box } of fits) assert.ok(glyph <= box, `font ${font}: glyph ${glyph}, box ${box}`);
});

await check('the first label is fully inside the track', async () => {
  const s = await labels();
  const top = s.list[0].worldY - s.box / 2;
  assert.ok(top >= s.trackTop - 0.51, `label top ${top}, track top ${s.trackTop}`);
});

await check('cells between labels are not covered', async () => {
  const alpha = await page.evaluate(() => {
    const t = window.__msaTrack;
    const ctx = t.labelCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const [a, b] = t.labelRows;
    return {
      between: ctx.getImageData(2 * dpr, ((a.y + b.y) / 2) * dpr, 1, 1).data[3],
      onLabel: ctx.getImageData(1 * dpr, a.y * dpr, 1, 1).data[3],
    };
  });
  assert.equal(alpha.between, 0);
  assert.ok(alpha.onLabel > 100 && alpha.onLabel < 200, `alpha ${alpha.onLabel}`);
});

await check('zooming with real wheel events only adds labels going in and removes them going out', async () => {
  const sweep = async (ticks, delta) => {
    const steps = [];
    await page.mouse.move(WIDTH / 2, 500);
    await page.keyboard.down('Shift');
    for (let i = 0; i < ticks; i++) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(40);
      steps.push(await labels());
    }
    await page.keyboard.up('Shift');
    return steps;
  };
  // Labels of `from` missing from `to`, among rows `to` spans.
  const gone = (from, to) => {
    const kept = new Set(to.list.map((l) => l.row));
    return from.list.filter((l) => l.row > to.list[0].row && l.row < to.list.at(-1).row && !kept.has(l.row));
  };

  const inward = await sweep(14, -120);
  for (let i = 0; i < inward.length; i++) {
    const s = inward[i];
    assert.equal(s.layerVisible, true);
    assert.ok(s.list.length > 0);
    assertNoOverlap(s);
    if (i > 0) assert.deepEqual(gone(inward[i - 1], s), [], `going in, rowPx ${s.rowPx}`);
  }
  assert.ok(inward.at(-1).rowPx > inward[0].rowPx);

  const outward = await sweep(20, 120);
  let appeared = 0;
  for (let i = 0; i < outward.length; i++) {
    const s = outward[i];
    assert.ok(s.list.length > 0);
    assertNoOverlap(s);
    if (i > 0) appeared += gone(s, outward[i - 1]).length;
  }
  assert.equal(outward.at(-1).rowPx, 1);
  await settle();
  console.log(`   ${appeared} labels appeared going out`);
});

await check('a mid zoom keeps the zoomed-out labels and adds to them', async () => {
  const far = await labels();
  await page.screenshot({ path: `${OUT}/labels-5-sparse.png` });
  await wheel(3, -120, { shift: true });
  await settle();
  const mid = await labels();
  assert.ok(mid.list.length > far.list.length * 0.5, `${far.list.length} -> ${mid.list.length}`);
  const midRows = new Set(mid.list.map((l) => l.row));
  const firstOnScreen = mid.list[0].row;
  const lastOnScreen = mid.list.at(-1).row;
  for (const l of far.list) {
    if (l.row >= firstOnScreen && l.row <= lastOnScreen) assert.ok(midRows.has(l.row), `row ${l.row} vanished`);
  }
  await page.screenshot({ path: `${OUT}/labels-6-mid.png` });
});

await check('scrolling thinned-out labels keeps the same rows labelled', async () => {
  const before = await labels();
  await shiftDrag(-200);
  const after = await labels();
  assert.ok(after.offset < before.offset);
  assertNoOverlap(after);
  const shared = before.list.filter((l) => after.list.some((m) => m.row === l.row));
  assert.ok(shared.length > 10);
});

await check('hovering a thinned-out label names that label, not the thin row under the cursor', async () => {
  const box = await origin();
  const s = await labels();
  const l = s.list.find((x) => x.worldY - s.box / 2 > s.trackTop && rowName(x.row).length < 10 && x.row > 0);
  // Near the label's edge, over a different row.
  const y = l.worldY - s.trackTop - s.box / 2 + 1;
  const rowUnderCursor = Math.floor((y - s.offset) / s.rowPx);
  assert.notEqual(rowUnderCursor, l.row);
  const text = await hoverText(box.left + 5, box.top + y);
  assert.ok(text.includes(rowName(l.row)) && !text.includes('Column'), `tooltip: ${text}`);
});

await check('hovering beside a thinned-out label reaches the cell underneath', async () => {
  const box = await origin();
  const s = await labels();
  const l = s.list.find((x) => rowName(x.row).length < 10 && x.worldY - s.box / 2 > s.trackTop);
  const y = l.worldY - s.trackTop;
  const row = Math.floor((y - s.offset) / s.rowPx);
  const text = await hoverText(box.left + l.right + 5, box.top + y);
  assert.ok(text.includes(rowName(row)) && text.includes('Column'), `tooltip: ${text}`);
});

await check('every row has a label with tall rows, with the right names', async () => {
  await wheel(25, -120, { shift: true });
  await settle();
  const s = await labels();
  assert.ok(s.rowPx >= 10, `rowPx=${s.rowPx}`);
  assert.equal(s.layerVisible, true);
  const shown = new Set(s.list.map((l) => l.row));
  const firstFull = Math.ceil(-s.offset / s.rowPx);
  const lastFull = Math.floor((1000 - s.offset) / s.rowPx) - 1;
  for (let r = firstFull; r <= lastFull; r++) assert.ok(shown.has(r), `row ${r} has no label`);
  const short = s.list.find((x) => rowName(x.row).length < 10);
  assert.equal(short.text, rowName(short.row));
  await page.screenshot({ path: `${OUT}/labels-1-overview.png` });
});

await check('each label is centered on its row on screen', async () => {
  const s = await labels();
  for (const l of s.list) {
    const center = s.trackTop + s.offset + (l.row + 0.5) * s.rowPx;
    assert.ok(Math.abs(l.worldY - center) <= 0.51, `row ${l.row}: label ${l.worldY}, row center ${center}`);
  }
});

await check('long names are shown in full and fit the canvas', async () => {
  const s = await labels();
  const canvasWidth = await page.evaluate(() => window.__msaTrack.labelCanvas.width / (window.devicePixelRatio || 1));
  assert.ok(s.list.some((x) => rowName(x.row).length > 30));
  for (const l of s.list) {
    assert.equal(l.text, rowName(l.row));
    assert.ok(l.right <= canvasWidth, `row ${l.row} right=${l.right}, canvas ${canvasWidth}`);
  }
});

await check('horizontal pan and zoom leave labels in place', async () => {
  const before = await labels();
  await wheel(5, -120);
  const after = await labels();
  assert.deepEqual(after.list.map((l) => [l.row, l.worldX, l.worldY]), before.list.map((l) => [l.row, l.worldX, l.worldY]));
  await settle();
});

await check('shift+drag scrolls labels', async () => {
  const before = await labels();
  await shiftDrag(-300);
  const after = await labels();
  assert.ok(after.offset < before.offset);
  assert.ok(after.list[0].row > before.list[0].row || after.list.at(-1).row > before.list.at(-1).row);
  for (const l of after.list) {
    const center = after.trackTop + after.offset + (l.row + 0.5) * after.rowPx;
    assert.ok(Math.abs(l.worldY - center) <= 0.51);
    const name = rowName(l.row);
    assert.equal(l.text, name);
  }
});

await check('labels can be turned off and back on', async () => {
  const setOption = (value) =>
    page.evaluate((v) => {
      const t = window.__msaTrack;
      t.rerender({ ...t.options, showRowLabels: v }, true);
      t.animate();
    }, value);
  await setOption(false);
  assert.equal((await labels()).layerVisible, false);
  await setOption(true);
  assert.equal((await labels()).layerVisible, true);
});

await check('changing the label width redraws to fit', async () => {
  const setWidth = (w) =>
    page.evaluate((value) => {
      const t = window.__msaTrack;
      t.rerender({ ...t.options, rowLabelWidth: value }, true);
      t.animate();
    }, w);
  await setWidth(80);
  const narrow = await labels();
  for (const l of narrow.list) assert.ok(l.right <= 80.5, `right=${l.right}`);
  await page.screenshot({ path: `${OUT}/labels-4-narrow-column.png` });
  await setWidth(140);
  const restored = await labels();
  const long = restored.list.find((x) => rowName(x.row).length > 30);
  assert.ok(long.text.length > narrow.list.find((x) => x.row === long.row).text.length);
  const cut = narrow.list.find((x) => x.row === long.row).text;
  assert.ok(cut.endsWith('…') && rowName(long.row).startsWith(cut.slice(0, -1)), cut);
  await setWidth(undefined);
  const full = await labels();
  assert.equal(full.list.find((x) => x.row === long.row).text, rowName(long.row));
});

await check('names outside ASCII reach the canvas intact', async () => {
  const text = await page.evaluate(() => {
    const t = window.__msaTrack;
    const row = t.labelRows[2].row;
    t.tilesetInfo.rowNames[row] = 'séq_β';
    t.labelDrawKey = null;
    t.labelKey = null;
    t.updateRowLabels();
    t.animate();
    return t.labelRows[2].text;
  });
  assert.equal(text, 'séq_β');
});

await check('hovering a raw cell shows the true name, column and residue', async () => {
  await zoomTo(500000, 500100);
  await wheel(10, -120, { shift: true });
  await settle();
  const box = await origin();
  const s = await labels();
  const domain = await page.evaluate(() => window.__msaTrack._xScale.domain());
  const pxX = 900;
  const pxY = 300;
  const column = Math.floor(domain[0] + (pxX / box.width) * (domain[1] - domain[0]));
  const row = Math.floor((pxY - s.offset) / s.rowPx);

  // Regenerate the cell outside the browser, independent of the track's lookup.
  const tile = rawTile(column - (column % 256), row - (row % 256), 256);
  tile.fill(COLUMNS);
  const byte = tile.data[(row % 256) * 256 + (column % 256)];
  const symbol = ['A', 'C', 'G', 'T', 'N', 'gap'][byte & 7];

  const text = await hoverText(box.left + pxX, box.top + pxY);
  assert.ok(text.includes(rowName(row)), `tooltip: ${text}, row ${row}`);
  assert.ok(text.includes(`Column ${column.toLocaleString('en-US')}`), `tooltip: ${text}, column ${column}`);
  assert.ok(text.includes(symbol), `tooltip: ${text}, symbol ${symbol}`);
  await page.screenshot({ path: `${OUT}/labels-2-letters-tooltip.png` });
  const alphaOverLetters = await page.evaluate(() => {
    const t = window.__msaTrack;
    const dpr = window.devicePixelRatio || 1;
    return t.labelCanvas.getContext('2d').getImageData(1 * dpr, t.labelRows[0].y * dpr, 1, 1).data[3];
  });
  assert.ok(alphaOverLetters > 230, `alpha ${alphaOverLetters}`);
});

await check('hovering a label shows the full name and no cell', async () => {
  const box = await origin();
  const s = await labels();
  const long = s.list.find((x) => rowName(x.row).length > 30);
  const y = long.worldY - s.trackTop;
  const text = await hoverText(box.left + 40, box.top + y);
  assert.ok(text.includes(rowName(long.row)), `tooltip: ${text}`);
  assert.ok(!text.includes('Column'), `tooltip: ${text}`);
});

await check('a row name cannot inject markup into the tooltip', async () => {
  const box = await origin();
  const s = await labels();
  const row = s.list[3].row;
  await page.evaluate((r) => {
    window.__msaTrack.tilesetInfo.rowNames[r] = '<img class="injected" src=x>';
  }, row);
  const text = await hoverText(box.left + 40, s.list[3].worldY - s.trackTop + box.top);
  assert.ok(text.includes('<img class="injected" src=x>'), `tooltip: ${text}`);
  assert.equal(await page.locator('img.injected').count(), 0);
});

await check('hover over an overview bin reports its column range', async () => {
  await wheel(40, 120, { shift: true });
  await zoomTo(0, COLUMNS);
  const box = await origin();
  const text = await hoverText(box.left + 900, box.top + 300);
  assert.ok(/Columns [\d,]+–[\d,]+/.test(text), `tooltip: ${text}`);
  assert.ok(text.includes('Mismatch'), `tooltip: ${text}`);
});

const percentile = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null;
};

const setLabels = (show) =>
  page.evaluate((v) => {
    const t = window.__msaTrack;
    t.rerender({ ...t.options, showRowLabels: v }, true);
    t.animate();
  }, show);

/** Whole-frame render time, waiting for the GPU, split by labels on and off. */
async function compare(name, action, rounds = 3) {
  const collected = { on: [], off: [] };
  for (let round = 0; round < rounds; round++) {
    // Alternate which goes first so warm-up doesn't favor one side.
    for (const show of round % 2 ? [false, true] : [true, false]) {
      await setLabels(show);
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.__msaFrames.renderMs.length = 0;
        window.__msaFrames.newTiles.length = 0;
        window.__msaFrames.forceGpuSync = true;
      });
      await action();
      const frames = await page.evaluate(() => {
        window.__msaFrames.forceGpuSync = false;
        const { renderMs, newTiles } = window.__msaFrames;
        return renderMs.filter((_, i) => newTiles[i] === 0);
      });
      collected[show ? 'on' : 'off'].push(...frames);
    }
  }
  const row = (values) => ({
    frames: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  });
  const summary = { on: row(collected.on), off: row(collected.off) };
  console.log(`   ${name}: labels on ${JSON.stringify(summary.on)}, off ${JSON.stringify(summary.off)}`);
  return summary;
}

await check('labels add little frame cost', async () => {
  await zoomTo(500000, 500100);
  // Row height that fits the most labels, which is the worst case.
  await wheel(7, -120, { shift: true });
  await settle();
  const rowPx = (await labels()).rowPx;
  assert.ok(rowPx >= 10 && rowPx < 14, `rowPx=${rowPx}`);
  await setLabels(true);
  await page.evaluate(() => {
    const t = window.__msaTrack;
    window.__labelRedrawMs = [];
    const original = t.drawLabelCanvas.bind(t);
    t.drawLabelCanvas = (...args) => {
      const started = performance.now();
      original(...args);
      window.__labelRedrawMs.push(performance.now() - started);
    };
  });

  const pan = await compare('x pan, labels unchanged', async () => {
    await page.mouse.move(WIDTH / 2, 500);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(WIDTH / 2 + 4 * Math.sin(i / 3), 500);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  const scroll = await compare('row scroll, labels moving', async () => {
    await shiftDrag(-120);
    await shiftDrag(120);
  });
  // Few frames per round, so more rounds: with under ~40 samples p95 is just the max.
  const zoom = await compare(
    'shift zoom, labels resizing',
    async () => {
      await wheel(3, -120, { shift: true });
      await wheel(3, 120, { shift: true });
    },
    10,
  );
  // Thinned-out labels, zooming across changes of stride.
  await wheel(14, 120, { shift: true });
  await settle();
  const thinZoom = await compare(
    'shift zoom, thinned-out labels',
    async () => {
      await wheel(3, -120, { shift: true });
      await wheel(3, 120, { shift: true });
    },
    10,
  );
  const redraws = await page.evaluate(() => window.__labelRedrawMs);
  const sorted = [...redraws].sort((a, b) => a - b);
  console.log(
    `   label redraw JS: n=${sorted.length} p50=${percentile(sorted, 0.5)} p95=${percentile(sorted, 0.95)} max=${percentile(sorted, 1)} ms`,
  );

  for (const [name, r] of Object.entries({ pan, scroll, zoom, thinZoom })) {
    assert.ok(r.on.p50 - r.off.p50 < 4, `${name}: median ${r.off.p50} -> ${r.on.p50} ms`);
    assert.ok(r.on.p95 < 33, `${name}: p95 with labels ${r.on.p95} ms`);
  }
  await setLabels(true);
  await wheel(7, -120, { shift: true });
  await page.mouse.move(WIDTH / 2, 500);
  await settle();
  await page.screenshot({ path: `${OUT}/labels-3-densest.png` });
});

assert.deepEqual(errors, []);
console.log(`\n${results.length} browser checks passed`);
await browser.close();
await server.close();
