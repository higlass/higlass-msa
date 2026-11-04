import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampOffset, letterAlpha, panRows, visibleRows, zoomRows } from '../src/rowView.js';

const base = { rowHeight: 1, maxRowHeight: 48, rows: 1000, height: 1000 };

test('zooming keeps the row under the cursor in place', () => {
  const view = zoomRows({ k: 1, offset: 0 }, { ...base, yPos: 300, kMultiplier: 0.5 });
  assert.equal(view.k, 2);
  assert.equal((300 - view.offset) / (base.rowHeight * view.k), 300);
});

test('anchor holds across repeated zooms', () => {
  let view = { k: 1, offset: 0 };
  for (let i = 0; i < 4; i++) view = zoomRows(view, { ...base, yPos: 400, kMultiplier: 0.5 });
  assert.equal(view.k, 16);
  assert.equal((400 - view.offset) / view.k, 400);
});

test('row height is limited at both ends', () => {
  const zoomedOut = zoomRows({ k: 1, offset: 0 }, { ...base, yPos: 0, kMultiplier: 2 });
  assert.equal(zoomedOut.k, 1);
  const zoomedIn = zoomRows({ k: 40, offset: 0 }, { ...base, yPos: 0, kMultiplier: 0.1 });
  assert.equal(zoomedIn.k, 48);
});

test('a row height already above the maximum does not break zooming', () => {
  const view = zoomRows({ k: 1, offset: 0 }, { ...base, rowHeight: 60, yPos: 0, kMultiplier: 0.5 });
  assert.equal(view.k, 1);
});

test('zooming back out pulls the rows into view', () => {
  const view = zoomRows({ k: 8, offset: -7000 }, { ...base, yPos: 1000, kMultiplier: 8 });
  assert.equal(view.k, 1);
  assert.equal(view.offset, 0);
});

test('panning stops at the first and last rows', () => {
  const zoomed = { k: 4, offset: -100 };
  assert.equal(panRows(zoomed, { ...base, dY: 500 }).offset, 0);
  assert.equal(panRows(zoomed, { ...base, dY: -1e6 }).offset, -3000);
  assert.equal(panRows(zoomed, { ...base, dY: -50 }).offset, -150);
});

test('rows shorter than the track stay at the top', () => {
  assert.equal(clampOffset(-20, 1, 100, 1000), 0);
  assert.equal(panRows({ k: 1, offset: 0 }, { ...base, rows: 100, dY: -50 }).offset, 0);
});

test('rows taller than the track at k=1 can be panned', () => {
  const tall = { ...base, rows: 5000 };
  assert.equal(panRows({ k: 1, offset: 0 }, { ...tall, dY: -1200 }).offset, -1200);
  assert.equal(panRows({ k: 1, offset: 0 }, { ...tall, dY: -1e6 }).offset, -4000);
});

test('visibleRows covers partially visible rows at both edges', () => {
  assert.deepEqual(visibleRows(0, 1, 1000, 1000), [0, 999]);
  assert.deepEqual(visibleRows(-25, 10, 1000, 100), [2, 12]);
});

test('visibleRows is limited to rows that exist', () => {
  assert.deepEqual(visibleRows(0, 1, 100, 1000), [0, 99]);
  assert.equal(visibleRows(-500, 1, 100, 100), null);
});

test('letters need room in both directions', () => {
  assert.equal(letterAlpha(20, 20), 1);
  assert.equal(letterAlpha(5, 40), 0);
  assert.equal(letterAlpha(40, 5), 0);
  assert.equal(letterAlpha(6.9, 6.9), 0);
  const fading = letterAlpha(8.5, 40);
  assert.ok(fading > 0 && fading < 1);
});
