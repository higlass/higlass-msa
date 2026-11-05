import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GAP_SYMBOL } from '../src/palette.js';
import { NO_SORT_KEY, orderBySymbol, parseSortKey, sortKey, sourceRow } from '../src/sortRows.js';
import { TILE_BINS, columnSymbols, overviewTile, rawTile } from '../src/synthetic/field.js';

const COLUMNS = 1 << 20;
const ROWS = 1000;

test('a sort key survives the trip through a tile id and back', () => {
  assert.equal(sortKey({ column: 0 }), 'c0');
  assert.equal(sortKey({ column: 123456 }), 'c123456');
  assert.deepEqual(parseSortKey('c123456'), { column: 123456 });
  // No sorting, and anything that isn't a column, is the one unsorted key.
  for (const sortBy of [null, undefined, {}, { column: -1 }, { column: 1.5 }, { column: 'x' }]) {
    assert.equal(sortKey(sortBy), NO_SORT_KEY);
  }
  for (const key of [NO_SORT_KEY, '', 'cx', 'c-1', 'c1.5', undefined]) {
    assert.equal(parseSortKey(key), null);
  }
});

test('rows are grouped by symbol, in symbol order, keeping the data order inside a group', () => {
  //            row: 0  1  2  3  4  5
  const symbols = [2, 0, GAP_SYMBOL, 0, 1, 2];
  assert.deepEqual([...orderBySymbol(symbols)], [1, 3, 4, 0, 5, 2]);
  // Which is: symbol 0 (rows 1, 3), symbol 1 (row 4), symbol 2 (rows 0, 5), gap (row 2).
});

test('an order is a permutation of every row, even with one symbol or none', () => {
  for (const symbols of [new Uint8Array(0), new Uint8Array(5), columnSymbols(7777, ROWS, COLUMNS)]) {
    const order = orderBySymbol(symbols);
    assert.equal(order.length, symbols.length);
    assert.deepEqual([...order].sort((a, b) => a - b), [...Array(symbols.length).keys()]);
  }
});

test('an unsorted row is its own source row', () => {
  assert.equal(sourceRow(null, 42), 42);
  assert.equal(sourceRow(Int32Array.of(7, 8, 9), 1), 8);
});

/** The symbol at `column` of each row of one raw tile, read off the tile itself. */
function tileColumn(column, firstRow, nRows, order) {
  const startColumn = column - (column % TILE_BINS);
  const tile = rawTile(startColumn, firstRow, nRows, order);
  tile.fill(COLUMNS);
  return Array.from({ length: nRows }, (_, y) => tile.data[y * TILE_BINS + (column % TILE_BINS)] & 7);
}

// What a user asks for when they sort: the clicked column becomes blocks of one symbol.
test('a tile built with the order has the sorted column in symbol order', () => {
  const column = 500_000;
  const order = orderBySymbol(columnSymbols(column, ROWS, COLUMNS));
  const sorted = tileColumn(column, 0, 256, order);
  for (let y = 1; y < sorted.length; y++) {
    assert.ok(sorted[y] >= sorted[y - 1], `row ${y}: ${sorted[y - 1]} then ${sorted[y]}`);
  }
  // Worth having only if it was out of order to begin with, and if gaps really sink.
  const unsorted = tileColumn(column, 0, 256, null);
  assert.ok(unsorted.some((s, y) => y > 0 && s < unsorted[y - 1]));
  const last = tileColumn(column, ROWS - 256, 256, order);
  assert.equal(last.at(-1), GAP_SYMBOL);
});

test('sorting only moves rows: every row of the data is still shown exactly once', () => {
  const column = 500_000;
  const order = orderBySymbol(columnSymbols(column, ROWS, COLUMNS));
  const blocks = ROWS / 256;
  const seen = [];
  for (let block = 0; block < Math.ceil(blocks); block++) {
    const firstRow = block * 256;
    const nRows = Math.min(256, ROWS - firstRow);
    const sorted = tileColumn(column, firstRow, nRows, order);
    // The cells of a sorted row are the cells of its source row, untouched.
    const sources = Array.from({ length: nRows }, (_, y) => order[firstRow + y]);
    for (let y = 0; y < nRows; y++) {
      assert.equal(sorted[y], tileColumn(column, sources[y], 1, null)[0]);
      seen.push(sources[y]);
    }
  }
  assert.deepEqual(seen.sort((a, b) => a - b), [...Array(ROWS).keys()]);
});

test('overview tiles are sorted the same way, so zooming out keeps the order', () => {
  const column = 500_000;
  const order = orderBySymbol(columnSymbols(column, ROWS, COLUMNS));
  for (const resolution of [4, 256]) {
    const sorted = overviewTile(0, resolution, 0, 8, order);
    sorted.fill(COLUMNS);
    for (let y = 0; y < 8; y++) {
      // Row y of the sorted tile must be row order[y] of the unsorted data, exactly.
      const plain = overviewTile(0, resolution, order[y], 1, null);
      plain.fill(COLUMNS);
      const bytes = (tile, row) => [
        ...tile.mean.subarray(row * TILE_BINS * 4, (row + 1) * TILE_BINS * 4),
        ...tile.peak.subarray(row * TILE_BINS * 4, (row + 1) * TILE_BINS * 4),
        ...tile.stats.subarray(row * TILE_BINS * 2, (row + 1) * TILE_BINS * 2),
      ];
      assert.deepEqual(bytes(sorted, y), bytes(plain, 0), `row ${y}, resolution ${resolution}`);
    }
  }
});
