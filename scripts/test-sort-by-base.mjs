// Sorting rows by a column, driven through the real right-click menu in Chrome.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

import { orderBySymbol } from '../src/sortRows.js';
import { columnSymbols, rowName } from '../src/synthetic/field.js';

const OUT = 'spike-output';
const WIDTH = 2000;
const HEIGHT = 1100;
const COLUMNS = 1000000;
const ROWS = 1000;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5197 }, logLevel: 'error' });
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

const results = [];
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log(`ok - ${name}`);
}

const origin = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    const r = window.__msaRenderer.view.getBoundingClientRect();
    return { left: r.left + t.position[0], top: r.top + t.position[1], width: t.dimensions[0], height: t.dimensions[1] };
  });

const state = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    return {
      sortByBase: t.options.sortByBase ?? null,
      rowOrder: t.rowOrder ? [...t.rowOrder] : null,
      tileIds: [...t.visibleTileIds].sort(),
      badTileIds: window.__msaStats.badTileIds,
      labels: t.labelRows.map((l) => ({ row: l.row, text: l.text })),
      names: Array.from({ length: 8 }, (_, row) => t.rowName(row)),
    };
  });

/** Symbol code at `column` for every row covered by a loaded raw tile. */
const columnOnScreen = (column) =>
  page.evaluate((col) => {
    const t = window.__msaTrack;
    const found = [];
    for (const tile of Object.values(t.fetchedTiles)) {
      const d = tile.tileData;
      if (!d || d.error || d.kind !== 'raw') continue;
      const x = col - d.startColumn;
      if (x < 0 || x >= d.validBins) continue;
      for (let y = 0; y < d.height; y++) {
        found.push({ row: d.rowBlock * 256 + y, symbol: d.data[y * d.width + x] & 7 });
      }
    }
    return found.sort((a, b) => a.row - b.row);
  }, column);

const zoomTo = async (a, b) => {
  await page.evaluate(([x, y]) => window.hgApi.zoomTo('main', x, y, x, y, 0), [a, b]);
  await page.waitForTimeout(250);
  await settle();
};

// HiGlass styles its menus with CSS modules, so the class names carry a build hash.
const MENU_ITEM = 'div[class*="context-menu-item"]';
const MENU_SPAN = 'span[class*="context-menu-span"]';

/** Right-clicks the track, opens the track's submenu and returns its item labels. */
async function openMenu(x, y) {
  await page.mouse.click(x, y, { button: 'right' });
  const view = page.locator('[data-menu-type="ViewContextMenu"]');
  await view.waitFor({ timeout: 5000 });
  await view.locator(MENU_ITEM, { hasText: 'msa' }).first().hover();
  const series = page.locator('[data-menu-type="SeriesListMenu"]');
  await series.waitFor({ timeout: 5000 });
  await page.waitForTimeout(100);
  return { series, labels: await series.locator(MENU_SPAN).allInnerTexts() };
}

async function clickMenuItem(x, y, label) {
  const { series, labels } = await openMenu(x, y);
  const item = series.locator(MENU_ITEM, { hasText: label }).first();
  assert.equal(await item.count(), 1, `"${label}" not in menu: ${JSON.stringify(labels)}`);
  await item.click();
  await page.waitForTimeout(300);
  await settle();
}

// editable=1 because HiGlass hides the right-click track menu on a locked view.
await page.goto(`${server.resolvedUrls.local[0]}?columns=${COLUMNS}&rows=${ROWS}&rowHeight=1&height=1000&editable=1`);
await page.waitForFunction(() => window.__msaReady);
await settle();

// A span of a few hundred columns, so one column is wide enough to aim at.
await zoomTo(500000, 500200);
const box = await origin();
const CLICK_X = 1200;
const column = await page.evaluate((x) => window.__msaTrack.columnAt(x), CLICK_X - box.left);
const expectedOrder = [...orderBySymbol(columnSymbols(column, ROWS, COLUMNS))];

await check('the unsorted track shows the data order', async () => {
  const s = await state();
  assert.equal(s.sortByBase, null);
  assert.equal(s.rowOrder, null);
  assert.deepEqual(s.names, Array.from({ length: 8 }, (_, r) => rowName(r)));
  for (const id of s.tileIds) assert.match(id, /^\d+\.\d+\.\d+\.u$/);
  const onScreen = await columnOnScreen(column);
  assert.equal(onScreen.length, ROWS);
  assert.ok(
    onScreen.some((c, i) => i > 0 && c.symbol < onScreen[i - 1].symbol),
    'column is already in symbol order, so sorting it proves nothing',
  );
  await page.screenshot({ path: `${OUT}/sort-0-unsorted.png` });
});

await check('the right-click menu offers the column under the cursor', async () => {
  const { labels } = await openMenu(CLICK_X, box.top + 400);
  assert.ok(
    labels.includes(`Sort rows by column ${column.toLocaleString('en-US')}`),
    `menu: ${JSON.stringify(labels)}`,
  );
  // Nothing to clear yet.
  assert.ok(!labels.includes('Clear row sorting'), `menu: ${JSON.stringify(labels)}`);
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 10);
  await page.waitForTimeout(200);
});

await check('sorting from the menu groups the rows by their symbol at that column', async () => {
  await clickMenuItem(CLICK_X, box.top + 400, 'Sort rows by column');
  const s = await state();
  assert.deepEqual(s.sortByBase, { column });
  assert.deepEqual(s.rowOrder, expectedOrder, 'track order differs from the order computed in node');

  const onScreen = await columnOnScreen(column);
  assert.equal(onScreen.length, ROWS);
  for (let i = 1; i < onScreen.length; i++) {
    assert.ok(
      onScreen[i].symbol >= onScreen[i - 1].symbol,
      `row ${onScreen[i].row}: ${onScreen[i - 1].symbol} then ${onScreen[i].symbol}`,
    );
  }
  // The cells really are the sorted rows' own cells, not a reshuffle of the screen.
  const truth = columnSymbols(column, ROWS, COLUMNS);
  for (const { row, symbol } of onScreen) assert.equal(symbol, truth[expectedOrder[row]]);
  await page.screenshot({ path: `${OUT}/sort-1-sorted.png` });
});

await check('tiles of a sorted view are different tiles, and all of them are sorted', async () => {
  const s = await state();
  assert.ok(s.tileIds.length > 1);
  for (const id of s.tileIds) assert.match(id, new RegExp(`^\\d+\\.\\d+\\.\\d+\\.c${column}$`));
  assert.deepEqual(s.badTileIds, []);
});

await check('names, labels and tooltips follow the rows they belong to', async () => {
  const s = await state();
  assert.deepEqual(s.names, expectedOrder.slice(0, 8).map((source) => rowName(source)));
  assert.ok(s.labels.length > 0);
  for (const l of s.labels) assert.equal(l.text, rowName(expectedOrder[l.row]));

  const label = s.labels.find((l) => l.row > 0);
  const text = await page.evaluate(
    ([row, trackX]) => {
      const t = window.__msaTrack;
      const y = t.rowView.offset + (row + 0.5) * t.rowPx;
      return t.getMouseOverHtml(trackX, y);
    },
    [label.row, 900],
  );
  assert.ok(text.includes(rowName(expectedOrder[label.row])), `tooltip: ${text}`);
});

await check('zooming out keeps the sorted order', async () => {
  await zoomTo(0, COLUMNS);
  const s = await state();
  const kinds = await page.evaluate(() =>
    [...new Set(Object.values(window.__msaTrack.fetchedTiles).map((t) => t.tileData?.kind))].sort(),
  );
  assert.deepEqual(kinds, ['overview']);
  for (const id of s.tileIds) assert.match(id, new RegExp(`\\.c${column}$`));
  assert.deepEqual(s.rowOrder, expectedOrder);
  await page.screenshot({ path: `${OUT}/sort-2-sorted-overview.png` });
});

await check('sorting a second column replaces the first sort', async () => {
  await zoomTo(300000, 300200);
  const secondBox = await origin();
  const second = await page.evaluate((x) => window.__msaTrack.columnAt(x), 700 - secondBox.left);
  assert.notEqual(second, column);
  await clickMenuItem(700, secondBox.top + 400, `Sort rows by column ${second.toLocaleString('en-US')}`);
  const s = await state();
  assert.deepEqual(s.sortByBase, { column: second });
  assert.deepEqual(s.rowOrder, [...orderBySymbol(columnSymbols(second, ROWS, COLUMNS))]);
  const onScreen = await columnOnScreen(second);
  for (let i = 1; i < onScreen.length; i++) assert.ok(onScreen[i].symbol >= onScreen[i - 1].symbol);
});

await check('clearing the sort puts the data order back', async () => {
  const secondBox = await origin();
  await clickMenuItem(700, secondBox.top + 400, 'Clear row sorting');
  const s = await state();
  assert.equal(s.sortByBase, null);
  assert.equal(s.rowOrder, null);
  for (const id of s.tileIds) assert.match(id, /\.u$/);
  assert.deepEqual(s.names, Array.from({ length: 8 }, (_, r) => rowName(r)));
  for (const l of s.labels) assert.equal(l.text, rowName(l.row));
  await page.screenshot({ path: `${OUT}/sort-3-cleared.png` });
});

await check('one order is fetched per sort, not one per tile', async () => {
  const requests = await page.evaluate(() => window.__msaFetchStats.orderRequests);
  assert.equal(requests, 2, `${requests} order requests for 2 sorts`);
});

await check('a view that starts sorted comes up sorted', async () => {
  const start = 250000;
  await page.goto(
    `${server.resolvedUrls.local[0]}?columns=${COLUMNS}&rows=${ROWS}&rowHeight=1&height=1000&sortColumn=${start}`,
  );
  await page.waitForFunction(() => window.__msaReady);
  await settle();
  await page.waitForFunction(() => window.__msaTrack.rowOrder !== null, null, { timeout: 10000 });
  const s = await state();
  const order = [...orderBySymbol(columnSymbols(start, ROWS, COLUMNS))];
  assert.deepEqual(s.sortByBase, { column: start });
  assert.deepEqual(s.rowOrder, order);
  assert.deepEqual(s.names, order.slice(0, 8).map((source) => rowName(source)));
  for (const id of s.tileIds) assert.match(id, new RegExp(`\\.c${start}$`));
  assert.deepEqual(s.badTileIds, []);
});

assert.deepEqual(errors, []);
console.log(`\n${results.length} browser checks passed`);
await browser.close();
await server.close();
