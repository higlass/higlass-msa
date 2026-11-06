import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mismatchEmphasis } from '../src/columnView.js';
import { MATCH_RGB, MISMATCH_RGB } from '../src/palette.js';
import { OVERVIEW_FRAGMENT } from '../src/shaders.js';
import { EXACT_RESOLUTION, TILE_BINS, overviewTile, rawTile } from '../src/synthetic/field.js';

const COLUMNS = 1 << 20;
const ROWS = 8;

const rawColor = (byte) => (byte & 8 ? MISMATCH_RGB : MATCH_RGB)[byte & 7];

/** Mean of the raw cell colors under each bin of one overview tile, per row. */
function aggregateRaw(resolution) {
  const sums = new Float64Array(TILE_BINS * ROWS * 3);
  const columnsPerTile = TILE_BINS;
  const rawTiles = (TILE_BINS * resolution) / columnsPerTile;
  for (let t = 0; t < rawTiles; t++) {
    const startColumn = t * columnsPerTile;
    const tile = rawTile(startColumn, 0, ROWS);
    tile.fill(COLUMNS);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < columnsPerTile; x++) {
        const bin = Math.floor((startColumn + x) / resolution);
        const rgb = rawColor(tile.data[y * columnsPerTile + x]);
        for (let c = 0; c < 3; c++) sums[(y * TILE_BINS + bin) * 3 + c] += rgb[c] / resolution;
      }
    }
  }
  return sums;
}

/** Mean absolute channel error between an overview tile's mean color and the raw truth. */
function meanColorError(resolution) {
  const truth = aggregateRaw(resolution);
  const tile = overviewTile(0, resolution, 0, ROWS);
  tile.fill(COLUMNS);
  let total = 0;
  for (let i = 0; i < TILE_BINS * ROWS; i++) {
    for (let c = 0; c < 3; c++) total += Math.abs(tile.mean[i * 4 + c] - truth[i * 3 + c]);
  }
  return total / (TILE_BINS * ROWS * 3);
}

// The point of fix 2: a bin's color is the average of the raw colors beneath it, so
// zooming out is a downsample rather than a different drawing. Each level must equal
// four bins of the level below averaged, which a modelled level does not: it drew
// resolution 16 as a plaid of row and column stripes with no cells left in it.
test('every level up to EXACT_RESOLUTION is an exact downsample of the raw colors', () => {
  assert.ok(EXACT_RESOLUTION >= 16, 'the level two steps out of raw must be exact');
  for (let resolution = 4; resolution <= EXACT_RESOLUTION; resolution *= 4) {
    const error = meanColorError(resolution);
    assert.ok(error < 0.5, `resolution ${resolution} error ${error}`);
  }
});

// Coarser levels are modelled from the field's rates, so a single bin wanders from
// the cells it covers. The average over a tile must stay close.
test('modelled bins stay near the raw average', () => {
  const resolution = EXACT_RESOLUTION * 4;
  const error = meanColorError(resolution);
  assert.ok(error < 10, `resolution ${resolution} error ${error}`);
});

test('a bin is never drawn outside the range its own colors span', () => {
  const resolution = 256;
  const tile = overviewTile(0, resolution, 0, ROWS);
  tile.fill(COLUMNS);
  for (let i = 0; i < TILE_BINS * ROWS; i++) {
    assert.equal(tile.mean[i * 4 + 3], 255);
    for (let c = 0; c < 3; c++) {
      // Mismatches darken, so the peak end is never paler than the mean end.
      assert.ok(tile.peak[i * 4 + c] <= tile.mean[i * 4 + c] + 1);
      assert.ok(tile.mean[i * 4 + c] >= 0 && tile.mean[i * 4 + c] <= 255);
    }
  }
});

/**
 * Mean color of each screen pixel when one tile's bins are drawn `binsPerPixel` wide.
 * This is what the GPU ends up showing, so two levels can be compared at the scale
 * where HiGlass would swap one for the other.
 */
function pixelRow(resolution, binsPerPixel, row) {
  const tile = overviewTile(0, resolution, 0, ROWS);
  tile.fill(COLUMNS);
  const pixels = TILE_BINS / binsPerPixel;
  const out = new Float64Array(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    for (let b = 0; b < binsPerPixel; b++) {
      const i = (row * TILE_BINS + p * binsPerPixel + b) * 4;
      for (let c = 0; c < 3; c++) out[p * 3 + c] += tile.mean[i + c] / binsPerPixel;
    }
  }
  return out;
}

// The point of fix 3: at the zoom where HiGlass swaps levels, both levels cover the
// same columns per pixel, and because both are averages of those columns they land on
// the same colors. Nothing about the picture has to change at the swap.
test('the levels either side of a zoom step agree at the step', () => {
  for (const [fine, coarse] of [
    [16, 64],
    [64, 256],
  ]) {
    let total = 0;
    let count = 0;
    for (let row = 0; row < ROWS; row++) {
      // One coarse bin per pixel is the same width as coarse/fine fine bins.
      const a = pixelRow(fine, coarse / fine, row);
      const b = pixelRow(coarse, 1, row);
      const shared = Math.min(a.length, b.length);
      for (let i = 0; i < shared; i++) total += Math.abs(a[i] - b[i]);
      count += shared;
    }
    const error = total / count;
    assert.ok(error < 4, `levels ${fine} and ${coarse} differ by ${error} per channel`);
  }
});

// A region holding a few of the field's hotspots, which are the only thing in it
// small enough to be widened by a mistake in aggregation.
const HOT_REGION = { from: 1 << 18, to: 1 << 19 };
const HOT_ROWS = 24;

/** Largest per-channel gap between each bin's mean colour and the raw truth under it. */
function binColorErrors(resolution, { from, to }) {
  const errors = [];
  const bins = (to - from) / resolution;
  for (let row = 0; row < HOT_ROWS; row++) {
    const truth = new Float64Array(bins * 3);
    for (let s = from; s < to; s += TILE_BINS) {
      const tile = rawTile(s, row, 1);
      tile.fill(COLUMNS);
      for (let x = 0; x < TILE_BINS; x++) {
        const bin = Math.floor((s + x - from) / resolution);
        const rgb = rawColor(tile.data[x]);
        for (let c = 0; c < 3; c++) truth[bin * 3 + c] += rgb[c] / resolution;
      }
    }
    for (let ts = from; ts < to; ts += TILE_BINS * resolution) {
      const tile = overviewTile(ts, resolution, row, 1);
      tile.fill(COLUMNS);
      for (let x = 0; x < TILE_BINS; x++) {
        const bin = (ts - from) / resolution + x;
        let worst = 0;
        for (let c = 0; c < 3; c++) {
          worst = Math.max(worst, Math.abs(tile.mean[x * 4 + c] - truth[bin * 3 + c]));
        }
        errors.push(worst);
      }
    }
  }
  errors.sort((a, b) => a - b);
  return errors;
}

/**
 * Hotspots are narrow windows inside much wider buckets: 400 hot columns in every
 * 20000. Modelling a bin from the bucket it falls in rather than from the hot columns
 * it really covers made every bin of a hot bucket fully hot, so one 400-column block
 * was drawn 20000 columns wide at resolution 256.
 *
 * The earlier tests average a whole tile, which hides that: the error is confined to
 * hot buckets and cancels against the rest. This one asks how far the worst bins are
 * off, which is what a block in the wrong place looks like. A few bins are expected to
 * be far off at resolution 16, where a bin holds too few cells to have a stable
 * colour of its own, so the bound is on a quantile rather than on the maximum.
 */
test('no bin is drawn far darker than the cells beneath it', () => {
  const bounds = { 16: 60, 64: 25, 256: 20 };
  for (const [resolution, bound] of Object.entries(bounds)) {
    const errors = binColorErrors(Number(resolution), HOT_REGION);
    const p999 = errors[Math.floor(0.999 * (errors.length - 1))];
    assert.ok(
      p999 < bound,
      `resolution ${resolution}: 1 bin in 1000 is off by ${p999.toFixed(1)} of 255, over ${bound}`,
    );
  }
});

test('emphasis fades out where the raw level takes over', () => {
  assert.equal(mismatchEmphasis(0.25), 0);
  assert.equal(mismatchEmphasis(1), 0);
  assert.equal(mismatchEmphasis(16), 1);
  assert.equal(mismatchEmphasis(4096), 1);
  assert.ok(mismatchEmphasis(4) > 0 && mismatchEmphasis(4) < mismatchEmphasis(8));
});

test('emphasis does not jump when HiGlass steps to the next zoom level', () => {
  // At the step, bins hold 4x the columns and are drawn 4x wider, so the ratio holds.
  const pixelsPerBin = 1.7;
  for (const resolution of [4, 16, 64, 256]) {
    assert.equal(
      mismatchEmphasis(resolution / pixelsPerBin),
      mismatchEmphasis((resolution * 4) / (pixelsPerBin * 4)),
    );
  }
});

// A bin must stay one flat block however wide it is drawn. Blending it into its
// neighbours smeared cells sideways, worst at four pixels per bin.
test('the overview shader never blends a bin into its neighbour', () => {
  assert.ok(!OVERVIEW_FRAGMENT.includes('uSmooth'));
  assert.equal(OVERVIEW_FRAGMENT.match(/texture2D/g).length, 2);
  for (const call of OVERVIEW_FRAGMENT.match(/texture2D\([^)]*\)/g)) {
    assert.ok(call.endsWith('vUv)'), `${call} samples somewhere other than this bin`);
  }
});
