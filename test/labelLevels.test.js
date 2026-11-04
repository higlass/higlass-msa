import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLabelIndex, buildLabelLevels, rowsInRange } from '../src/labelLevels.js';
import { labelBoxPx, labelFontSize, labelY, placeLabels, visibleLabels } from '../src/rowLabels.js';

function scrambled(n, seed = 1) {
  return Array.from({ length: n }, (_, i) => {
    let h = Math.imul(i + seed, 0x9e3779b1);
    h ^= h >>> 15;
    return (Math.imul(h, 0x85ebca6b) >>> 0) % 1000;
  });
}

const CASES = {
  scrambled: scrambled(5000),
  'rising gradient': Array.from({ length: 5000 }, (_, i) => i),
  'falling gradient': Array.from({ length: 5000 }, (_, i) => -i),
  'one long name in seven': Array.from({ length: 5000 }, (_, i) => (i % 7 === 3 ? 52 : 8)),
  'important rows clustered': Array.from({ length: 5000 }, (_, i) => (i >= 2000 && i < 2100 ? 9 : 1)),
};

for (const [name, importance] of Object.entries(CASES)) {
  const levels = buildLabelLevels(importance);

  test(`${name}: rows in a level are far enough apart`, () => {
    levels.forEach((rows, level) => {
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i] - rows[i - 1] >= 2 ** level);
    });
  });

  test(`${name}: each level is a subset of the one below`, () => {
    for (let level = 1; level < levels.length; level++) {
      const below = new Set(levels[level - 1]);
      for (const row of levels[level]) assert.ok(below.has(row), `level ${level} row ${row}`);
    }
  });

  test(`${name}: a removed row always had a row at least as important nearby`, () => {
    for (let level = 1; level < levels.length; level++) {
      const kept = new Set(levels[level]);
      for (const row of levels[level - 1]) {
        if (kept.has(row)) continue;
        const beaten = [...levels[level]].some(
          (other) => Math.abs(other - row) < 2 ** level && importance[other] >= importance[row],
        );
        assert.ok(beaten, `level ${level} row ${row}`);
      }
    }
  });

  test(`${name}: no large holes`, () => {
    levels.forEach((rows, level) => {
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i] - rows[i - 1] < 2 ** (level + 2));
    });
  });

  test(`${name}: the most important row survives to the top level`, () => {
    const top = levels.at(-1);
    assert.equal(top.length, 1);
    assert.equal(importance[top[0]], Math.max(...importance));
  });
}

test('equal importance gives multiples of powers of two', () => {
  const levels = buildLabelLevels(new Uint8Array(1000));
  levels.forEach((rows, level) => {
    const expected = [];
    for (let r = 0; r < 1000; r += 2 ** level) expected.push(r);
    assert.deepEqual([...rows], expected);
  });
});

test('long names are never removed by short ones', () => {
  const importance = CASES['one long name in seven'];
  const all = buildLabelLevels(importance);
  // Same rows and order of preference, with the short names gone.
  const longOnly = importance.map((v) => (v === 52 ? 52 : 8));
  const isLong = (r) => longOnly[r] === 52;
  for (let level = 1; level < all.length; level++) {
    const below = all[level - 1].filter(isLong);
    const kept = new Set(all[level].filter(isLong));
    for (const row of below) {
      if (kept.has(row)) continue;
      assert.ok([...kept].some((k) => Math.abs(k - row) < 2 ** level), `row ${row} lost at level ${level}`);
    }
  }
});

test('labels never overlap on screen at any row size', () => {
  for (const importance of Object.values(CASES)) {
    const index = buildLabelIndex(importance);
    for (let rowPx = 48; rowPx >= 0.05; rowPx *= 0.9) {
      const box = labelBoxPx(labelFontSize(rowPx));
      const rows = visibleLabels(index, 0, rowPx, 100000);
      for (let i = 1; i < rows.length; i++) {
        const gap = labelY(rows[i], rowPx) - labelY(rows[i - 1], rowPx);
        assert.ok(gap >= box - 1e-9, `rowPx=${rowPx} gap=${gap} box=${box}`);
      }
    }
  }
});

test('labels on screen stay as you zoom in', () => {
  for (const [name, importance] of Object.entries(CASES)) {
    const index = buildLabelIndex(importance);
    let previous = new Set();
    for (let rowPx = 0.05; rowPx <= 48; rowPx *= 1.05) {
      const rows = new Set(visibleLabels(index, 0, rowPx, 1e7, previous));
      for (const r of previous) assert.ok(rows.has(r), `${name}: row ${r} vanished at rowPx=${rowPx}`);
      previous = rows;
    }
  }
});

test('labels on screen stay as you scroll, while they remain in view', () => {
  for (const [name, importance] of Object.entries(CASES)) {
    const index = buildLabelIndex(importance);
    let previous = new Set(visibleLabels(index, 0, 1, 1000));
    for (let offset = -7; offset > -3000; offset -= 7) {
      const rows = new Set(visibleLabels(index, offset, 1, 1000, previous));
      const top = -offset;
      for (const r of previous) {
        if (r > top + 20 && r < top + 980) assert.ok(rows.has(r), `${name}: row ${r} vanished at ${offset}`);
      }
      previous = rows;
    }
  }
});

test('with no history, the most wanted of two clashing rows wins', () => {
  const rank = Int32Array.from([3, 2, 0, 1]);
  assert.deepEqual(placeLabels([0, 1, 2, 3], rank, new Set(), 4), [2]);
});

test('a label already showing beats a more wanted row', () => {
  const rank = Int32Array.from([3, 2, 0, 1]);
  assert.deepEqual(placeLabels([0, 1, 2, 3], rank, new Set([1]), 4), [1]);
});

test('zoomed out with many rows, candidates stay few and placing is fast', () => {
  const index = buildLabelIndex(scrambled(1_000_000));
  const started = performance.now();
  let total = 0;
  for (let i = 0; i < 1000; i++) total += visibleLabels(index, -(i % 100), 0.001, 1000).length;
  const ms = performance.now() - started;
  console.log(`# 1M rows: ${(ms / 1000).toFixed(3)} ms per placement, ${total / 1000} labels`);
  assert.ok(total / 1000 > 30);
  assert.ok(ms / 1000 < 4, `${ms / 1000} ms`);
});

test('rowsInRange is inclusive and copes with fractions and missing levels', () => {
  const levels = buildLabelLevels(new Uint8Array(100));
  assert.deepEqual([...rowsInRange(levels, 2, 3.5, 12)], [4, 8, 12]);
  assert.deepEqual([...rowsInRange(levels, 99, 0, 99)], [0]);
  assert.deepEqual([...rowsInRange([], 0, 0, 10)], []);
  assert.deepEqual([...rowsInRange(levels, 0, 200, 300)], []);
});

test('a single row works, and no rows gives no levels', () => {
  assert.deepEqual(buildLabelLevels([5]).map((l) => [...l]), [[0]]);
  assert.deepEqual(buildLabelLevels([]), []);
});

test('one million rows build quickly', () => {
  const started = performance.now();
  const levels = buildLabelLevels(scrambled(1_000_000));
  const ms = performance.now() - started;
  console.log(`# 1M rows: ${ms.toFixed(0)} ms, ${levels.reduce((n, l) => n + l.length, 0)} entries`);
  assert.ok(ms < 5000, `${ms} ms`);
});
