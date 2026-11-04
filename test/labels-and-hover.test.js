import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cellAt, escapeHtml, tooltipHtml } from '../src/hover.js';
import { buildLabelIndex } from '../src/labelLevels.js';
import {
  MAX_FONT_PX,
  MIN_FONT_PX,
  labelBoxPx,
  labelFontSize,
  labelStride,
  labelText,
  labelY,
  visibleLabels,
} from '../src/rowLabels.js';

test('label font scales with the row within limits', () => {
  assert.equal(labelFontSize(1), MIN_FONT_PX);
  assert.equal(labelFontSize(16), 12);
  assert.equal(labelFontSize(48), MAX_FONT_PX);
});

test('label font only takes a few sizes as rows grow', () => {
  const sizes = new Set();
  for (let rowPx = 1; rowPx <= 48; rowPx += 0.1) sizes.add(labelFontSize(rowPx));
  assert.equal(sizes.size, MAX_FONT_PX - MIN_FONT_PX + 1);
});

const rowSizes = () => {
  const sizes = [];
  for (let rowPx = 48; rowPx >= 0.05; rowPx *= 0.97) sizes.push(rowPx);
  return sizes;
};

const uniformLevels = new Map();
const labelSet = (rowPx, rows, offset = 0, height = 1000) => {
  if (!uniformLevels.has(rows)) uniformLevels.set(rows, buildLabelIndex(new Uint8Array(rows)));
  return visibleLabels(uniformLevels.get(rows), offset, rowPx, height);
};

test('every row is labelled once rows are tall enough', () => {
  assert.equal(labelStride(10), 1);
  assert.equal(labelStride(48), 1);
  assert.deepEqual(labelSet(20, 1000, 0, 100), [0, 1, 2, 3, 4]);
});

test('labels never overlap at any row size, including the moved label on row 0', () => {
  for (const rowPx of rowSizes()) {
    const rows = labelSet(rowPx, 1e6);
    const box = labelBoxPx(labelFontSize(rowPx));
    for (let i = 1; i < rows.length; i++) {
      const gap = labelY(rows[i], rowPx) - labelY(rows[i - 1], rowPx);
      assert.ok(gap >= box - 1e-9, `rowPx=${rowPx} gap=${gap} box=${box}`);
    }
  }
});

test('equal importance packs at least as many labels as an even stride', () => {
  for (const rowPx of rowSizes()) {
    const spacing = labelStride(rowPx) * rowPx;
    const count = labelSet(rowPx, 1e6, 0, 1000).length;
    assert.ok(count >= 1000 / Math.max(spacing, 1) - 1, `rowPx=${rowPx} count=${count}`);
  }
});

test('every labelled row on screen is included, and rows far off screen are not', () => {
  const rowPx = 4;
  const offset = -2000; // Row 500 is at the top.
  const stride = labelStride(rowPx);
  const rows = labelSet(rowPx, 5000, offset, 400);
  assert.ok(rows.at(-1) + stride > 600, `last ${rows.at(-1)}`);
  assert.ok(rows[0] <= 500 + stride && rows[0] >= 500 - 2 * stride, `first ${rows[0]}`);
  assert.ok(rows.at(-1) <= 600 + stride, `last ${rows.at(-1)}`);
});

test('no labels when the view is past the last row, and the last row can be labelled', () => {
  assert.deepEqual(labelSet(20, 3, -1000, 100), []);
  assert.deepEqual(labelSet(20, 3, 0, 100), [0, 1, 2]);
  assert.deepEqual(labelSet(0.5, 1, 0, 100), [0]);
});

test('row 0 keeps its whole label inside the alignment', () => {
  const box = labelBoxPx(labelFontSize(1));
  assert.equal(labelY(0, 1), box / 2);
  assert.equal(labelY(0, 40), 20);
  assert.equal(labelY(16, 1), 16.5);
});

test('short names are left alone', () => {
  assert.equal(labelText('seq_1', 10), 'seq_1');
  assert.equal(labelText('seq_1', 5), 'seq_1');
});

test('long names are cut to fit, ellipsis included', () => {
  const text = labelText('Homo_sapiens_chr1', 8);
  assert.equal(text, 'Homo_sa…');
  assert.equal(text.length, 8);
});

test('label text survives very narrow columns', () => {
  assert.equal(labelText('abc', 1), '…');
  assert.equal(labelText('abc', 0), '');
});

test('non-ASCII names are kept, and truncation never splits a character', () => {
  assert.equal(labelText('séquence_β', 20), 'séquence_β');
  assert.equal(labelText('𝛼𝛽𝛾𝛿𝜀', 3), '𝛼𝛽…');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="a('b')">&`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
  );
});

test('tooltips escape row names', () => {
  const html = tooltipHtml('<script>alert(1)</script>', null);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

const rawTile = () => {
  const data = new Uint8Array(256 * 4);
  data[2 * 256 + 3] = 2 | 8; // block row 2, bin 3: G, mismatch
  data[1 * 256 + 5] = 5; // block row 1, bin 5: gap
  return { kind: 'raw', data, width: 256, height: 4, validBins: 100, startColumn: 512, resolution: 1, rowBlock: 1 };
};

test('cellAt reads the right raw cell, offset by tile and row block', () => {
  assert.deepEqual(cellAt(rawTile(), 515, 258), { kind: 'raw', column: 515, symbol: 'G', mismatch: true });
  assert.deepEqual(cellAt(rawTile(), 517, 257), { kind: 'raw', column: 517, symbol: 'gap', mismatch: false });
});

test('cellAt returns null outside the tile', () => {
  const tile = rawTile();
  assert.equal(cellAt(tile, 511, 258), null);
  assert.equal(cellAt(tile, 512 + 100, 258), null);
  assert.equal(cellAt(tile, 515, 255), null);
  assert.equal(cellAt(tile, 515, 260), null);
});

test('cellAt reports the column range of an overview bin', () => {
  const bin = 1 * 256 + 2;
  const peak = new Uint8Array(256 * 4 * 4);
  const stats = new Uint8Array(256 * 4 * 2);
  peak.set([0, 0, 0, 102], bin * 4);
  stats.set([255, 51], bin * 2);
  const tile = { kind: 'overview', peak, stats, width: 256, height: 4, validBins: 256, startColumn: 1024, resolution: 16, rowBlock: 0 };
  const cell = cellAt(tile, 1024 + 2 * 16 + 7, 1);
  assert.equal(cell.firstColumn, 1056);
  assert.equal(cell.lastColumn, 1071);
  assert.equal(cell.nonGap, 1);
  assert.ok(Math.abs(cell.mismatch - 0.2) < 1e-9);
  assert.ok(Math.abs(cell.peak - 0.4) < 1e-9);
});

test('tooltip describes raw cells, gaps and overview bins', () => {
  const raw = tooltipHtml('s', { kind: 'raw', column: 1234567, symbol: 'G', mismatch: true });
  assert.ok(raw.includes('Column 1,234,567') && raw.includes('G (differs from consensus)'));
  const gap = tooltipHtml('s', { kind: 'raw', column: 1, symbol: 'gap', mismatch: false });
  assert.ok(gap.includes('gap') && !gap.includes('consensus'));
  const bin = tooltipHtml('s', { kind: 'overview', firstColumn: 16, lastColumn: 31, nonGap: 0.5, mismatch: 0.25, peak: 1 });
  assert.ok(bin.includes('Columns 16–31') && bin.includes('50.0%') && bin.includes('peak 100.0%'));
});
