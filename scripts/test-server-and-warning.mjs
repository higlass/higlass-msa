// Browser checks for two things:
//   1. synthetic data warns when zoomed out past APPROXIMATE_ABOVE columns per bin,
//      and stops warning once zoomed back in;
//   2. the msa-server data fetcher draws tiles from a tile server.
// Part 2 runs only when MSA_SERVER and MSA_TILESET are set, e.g.
//   MSA_SERVER=http://localhost:8000/api/v1 MSA_TILESET=msa-chrM node scripts/test-server-and-warning.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

import { APPROXIMATE_ABOVE } from '../src/synthetic/field.js';

const OUT = process.env.MSA_SHOTS ?? 'spike-output/server-and-warning';
mkdirSync(OUT, { recursive: true });
const { MSA_SERVER, MSA_TILESET } = process.env;

const vite = await createServer({ server: { port: 5196 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 500 } });
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
  await page.waitForTimeout(300);
}

const warning = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    return { visible: t.warningLayer.visible, text: t.warningText.text, resolution: t.currentResolution() };
  });

async function zoomTo(start, end) {
  await page.evaluate(([s, e]) => window.hgApi.zoomTo('main', s, e, s, e, 0), [start, end]);
  await page.waitForTimeout(200);
  await settle();
}

try {
  await page.goto('http://localhost:5196/demo/?columns=1000000&rows=300&height=300');
  await page.waitForFunction(() => window.__msaReady);
  await settle();

  let w = await warning();
  assert.ok(w.resolution > APPROXIMATE_ABOVE, `full view should be coarse, got ${w.resolution}`);
  assert.ok(w.visible, 'warning shown when zoomed out');
  assert.match(w.text, new RegExp(`past ${APPROXIMATE_ABOVE} columns per bin`));
  await page.screenshot({ path: `${OUT}/synthetic-zoomed-out.png` });
  console.log(`ok - warning at ${w.resolution} columns per bin`);

  // 1000 px over 4000 columns is the 16-column level or finer: no warning.
  await zoomTo(500000, 504000);
  w = await warning();
  assert.ok(w.resolution <= APPROXIMATE_ABOVE, `expected a fine level, got ${w.resolution}`);
  assert.ok(!w.visible, 'no warning at or below the limit');
  console.log(`ok - no warning at ${w.resolution} columns per bin`);

  // Just past the limit it warns again.
  await zoomTo(500000, 560000);
  w = await warning();
  assert.equal(w.visible, w.resolution > APPROXIMATE_ABOVE);
  console.log(`ok - warning ${w.visible ? 'on' : 'off'} at ${w.resolution} columns per bin`);

  if (MSA_SERVER && MSA_TILESET) {
    const url = `http://localhost:5196/demo/?server=${encodeURIComponent(MSA_SERVER)}&tileset=${MSA_TILESET}&rowHeight=4&height=400`;
    await page.goto(url);
    await page.waitForFunction(() => window.__msaReady);
    await settle();
    const s = await page.evaluate(() => {
      const t = window.__msaTrack;
      const tiles = Object.values(t.fetchedTiles).map((x) => x.tileData);
      return {
        warning: t.warningLayer.visible,
        name0: t.rowName(0),
        rows: t.tilesetInfo.shape[0],
        kinds: [...new Set(tiles.map((d) => d.kind))],
        errors: tiles.filter((d) => d.error).map((d) => d.error),
        badTileIds: window.__msaStats.badTileIds,
        meanBytes: tiles.map((d) => d.mean?.length ?? 0),
        width: tiles.map((d) => d.width * d.height * 4),
      };
    });
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.badTileIds, []);
    assert.ok(!s.warning, 'a tile server is exact, so no warning');
    assert.deepEqual(s.kinds, ['overview']);
    assert.deepEqual(s.meanBytes, s.width, 'mean expanded to RGBA');
    await page.screenshot({ path: `${OUT}/server-full.png` });
    console.log(`ok - server overview, ${s.rows} rows, first row ${s.name0}`);

    await zoomTo(1000, 1250);
    const raw = await page.evaluate(() => Object.values(window.__msaTrack.fetchedTiles).map((x) => x.tileData.kind));
    assert.ok(raw.includes('raw'), `expected raw tiles, got ${raw}`);
    await page.screenshot({ path: `${OUT}/server-raw.png` });
    console.log('ok - server raw tiles');

    const order = await page.evaluate(() => window.__msaTrack.dataFetcher.rowOrder({ column: 1100 }));
    assert.equal(Object.keys(order).length, s.rows);
    console.log('ok - server row order');

    // Reference coordinates: x is a position on the reference (hg38.chr22, say).
    await page.goto(`${url}&coordinates=reference`);
    await page.waitForFunction(() => window.__msaReady);
    await settle();
    const info = await page.evaluate(() => {
      const t = window.__msaTrack;
      return { coordinates: t.tilesetInfo.coordinates, width: t.tilesetInfo.shape[1], reference: t.tilesetInfo.reference };
    });
    assert.equal(info.coordinates, 'reference');
    assert.equal(info.width, info.reference.length);
    // Somewhere aligned: the middle of the reference, 250 bases wide.
    const middle = Math.floor(info.reference.length / 2);
    await zoomTo(middle, middle + 250);
    const r = await page.evaluate(() => {
      const t = window.__msaTrack;
      const tiles = Object.values(t.fetchedTiles).map((x) => x.tileData);
      return {
        kinds: [...new Set(tiles.map((d) => `${d.kind}/${d.coordinates}`))],
        errors: tiles.filter((d) => d.error).map((d) => d.error),
        tooltip: t.getMouseOverHtml(600, 10),
      };
    });
    assert.deepEqual(r.errors, []);
    assert.ok(r.kinds.includes('raw/reference'), `expected raw reference tiles, got ${r.kinds}`);
    assert.match(r.tooltip, new RegExp(`${info.reference.name.replace('.', '\\.')}:[\\d,]+`));
    await page.screenshot({ path: `${OUT}/server-reference-raw.png` });
    console.log(`ok - reference coordinates, tooltip "${r.tooltip.replace(/<br>/g, ' | ')}"`);

    const refOrder = await page.evaluate((p) => window.__msaTrack.dataFetcher.rowOrder({ column: p }), middle + 100);
    assert.ok(refOrder === null || refOrder.length === s.rows, 'order by reference position');
    console.log(`ok - reference row order (${refOrder ? 'sorted' : 'position in no block'})`);

    // Whole-genome x with hg38 tracks from resgen.io (needs the network).
    if (process.env.MSA_GENOME) {
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.goto(`${url}&genome=${process.env.MSA_GENOME}`);
      await page.waitForFunction(() => window.__msaReady);
      await settle();
      const offset = await page.evaluate(() => window.__msaTrack.tilesetInfo.xOffset);
      assert.ok(offset > 0, `expected an offset into the genome, got ${offset}`);
      await page.screenshot({ path: `${OUT}/genome-chromosome.png` });
      // 2 kb in the middle of the chromosome, then the bases.
      await zoomTo(offset + middle, offset + middle + 2000);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/genome-2kb.png` });
      await zoomTo(offset + middle, offset + middle + 250);
      const g = await page.evaluate(() => {
        const t = window.__msaTrack;
        return {
          tooltip: t.getMouseOverHtml(0.5 * t.dimensions[0], 10),
          errors: Object.values(t.fetchedTiles).filter((x) => x.tileData.error).map((x) => x.tileData.error),
        };
      });
      assert.deepEqual(g.errors, []);
      // The middle of the screen is ~125 bases in: the tooltip shows the chromosome
      // position, not the genome one.
      const shown = +g.tooltip.match(/:([\d,]+)/)[1].replace(/,/g, '');
      assert.ok(Math.abs(shown - (middle + 125)) <= 2, `tooltip at ${shown}, expected ~${middle + 125}`);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/genome-bases.png` });
      console.log(`ok - genome view, chromosome starts at ${offset.toLocaleString('en-US')}, tooltip at ${shown}`);
    }
  } else {
    console.log('skip - set MSA_SERVER and MSA_TILESET to check tile server data');
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await vite.close();
}
