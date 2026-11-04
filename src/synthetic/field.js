// Deterministic stand-in for a real alignment, used to exercise rendering only.
//
// Raw tiles are per-cell samples of this field. Overview tiles up to EXACT_RESOLUTION
// are aggregated from those same cells, so the first step out of the raw level is a
// true downsample. Coarser levels are modelled from the field's own rates instead,
// because visiting every cell of a 4096-column bin is too slow to do in a demo
// fetcher. Those levels therefore do NOT validate the aggregation rules; that is the
// job of the real builder.

import { GAP_RGB, GAP_SYMBOL, MATCH_RGB, MISMATCH_MEAN_RGB, MISMATCH_RGB } from '../palette.js';

export const TILE_BINS = 256;
export const BLOCK_ROWS = 256;
const HOT_SPACING = 20000;
const HOT_WIDTH = 400;
const HOT_RATE = 0.8;

function hash(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const rowRate = (r) => 0.005 + 0.06 * hash(r, 1) ** 2;

function regionRate(col, columns) {
  const t = (col / columns) * 64;
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return 0.1 * (hash(i, 2) * (1 - s) + hash(i + 1, 2) * s);
}

const isHotBucket = (b) => hash(b, 3) > 0.93;
const rowInHotspot = (r, b) => hash(r >> 4, b) > 0.5;

function gapRate(r, col) {
  return hash(r >> 3, Math.floor(col / 2000) + 7) > 0.97 ? 0.95 : 0.01;
}

/** Mostly short names, with some long ones to exercise truncation. */
export function rowName(r) {
  const id = String(r).padStart(4, '0');
  return r % 7 === 3 ? `Homo_sapiens_isolate_HG${id}_chromosome_1_assembly_v2` : `seq_${id}`;
}

export function resolutions(columns) {
  const out = [1];
  while (out[out.length - 1] * TILE_BINS < columns) out.push(out[out.length - 1] * 4);
  return out;
}

export function rawTile(startColumn, firstRow, nRows) {
  const data = new Uint8Array(TILE_BINS * nRows);
  return { data, fill: (columns) => fillRaw(data, startColumn, firstRow, nRows, columns) };
}

/**
 * An overview tile carries two colors per bin instead of a derived heat value:
 *
 *   mean   RGB, the average of the raw cell colors in the bin; A unused
 *   peak   RGB, the same bin drawn at its peak mismatch rate; A = that rate
 *   stats  2 bytes, non-gap fraction and mean mismatch rate, for the tooltip only
 *
 * `mean` alone would make a zoomed-out view a plain downsample of the zoomed-in one,
 * which is the goal, but rare mismatches average into invisibility. `peak` is the
 * other end of the same color ramp, and the shader fades between them with zoom.
 */
export function overviewTile(startColumn, resolution, firstRow, nRows) {
  const mean = new Uint8Array(TILE_BINS * nRows * 4);
  const peak = new Uint8Array(TILE_BINS * nRows * 4);
  const stats = new Uint8Array(TILE_BINS * nRows * 2);
  return {
    mean,
    peak,
    stats,
    fill: (columns) =>
      fillOverview({ mean, peak, stats }, startColumn, resolution, firstRow, nRows, columns),
  };
}

/** One cell: low 3 bits = symbol, bit 3 = differs from consensus. `base` is rowRate(r). */
function cellByte(r, c, base, columns) {
  if (hash(r * 31 + 11, c) < gapRate(r, c)) return GAP_SYMBOL;
  const consensus = Math.floor(hash(c, 4) * 4);
  const bucket = Math.floor(c / HOT_SPACING);
  const hot = c % HOT_SPACING < HOT_WIDTH && isHotBucket(bucket) && rowInHotspot(r, bucket);
  const rate = hot ? HOT_RATE : base + regionRate(c, columns);
  if (hash(r * 31 + 7, c) >= rate) return consensus;
  return ((consensus + 1 + Math.floor(hash(r * 17 + 3, c) * 3)) % 4) | 8;
}

const cellRgb = (byte) => (byte & 8 ? MISMATCH_RGB : MATCH_RGB)[byte & 7];

function fillRaw(data, startColumn, firstRow, nRows, columns) {
  for (let y = 0; y < nRows; y++) {
    const r = firstRow + y;
    const base = rowRate(r);
    for (let x = 0; x < TILE_BINS; x++) {
      data[y * TILE_BINS + x] = cellByte(r, startColumn + x, base, columns);
    }
  }
}

const SAMPLES = 8;
/** Bins no wider than this are aggregated cell by cell, at that many times raw cost. */
export const EXACT_RESOLUTION = 4;

/** Mismatches sit on the matching background; gaps replace both. */
const channel = (nonGap, match, differ, rate, gap) =>
  Math.round(nonGap * (match + (differ - match) * rate) + (1 - nonGap) * gap);

function fillOverview(out, startColumn, resolution, firstRow, nRows, columns) {
  const fill = resolution <= EXACT_RESOLUTION ? fillOverviewExact : fillOverviewModelled;
  fill(out, startColumn, resolution, firstRow, nRows, columns);
}

/**
 * Averages the real cells. The bin is then honest about its own mismatch rate, so
 * there is nothing to exaggerate and the peak color is the mean color.
 */
function fillOverviewExact({ mean, peak, stats }, startColumn, resolution, firstRow, nRows, columns) {
  for (let y = 0; y < nRows; y++) {
    const r = firstRow + y;
    const base = rowRate(r);
    for (let x = 0; x < TILE_BINS; x++) {
      const c0 = startColumn + x * resolution;
      let sum0 = 0;
      let sum1 = 0;
      let sum2 = 0;
      let gaps = 0;
      let mismatches = 0;
      for (let s = 0; s < resolution; s++) {
        const byte = cellByte(r, c0 + s, base, columns);
        const rgb = cellRgb(byte);
        sum0 += rgb[0];
        sum1 += rgb[1];
        sum2 += rgb[2];
        if ((byte & 7) === GAP_SYMBOL) gaps++;
        else if (byte & 8) mismatches++;
      }
      const nonGap = resolution - gaps;
      const rate = nonGap > 0 ? mismatches / nonGap : 0;
      const i = (y * TILE_BINS + x) * 4;
      mean[i] = peak[i] = Math.round(sum0 / resolution);
      mean[i + 1] = peak[i + 1] = Math.round(sum1 / resolution);
      mean[i + 2] = peak[i + 2] = Math.round(sum2 / resolution);
      mean[i + 3] = 255;
      peak[i + 3] = Math.round(255 * rate);
      const j = (y * TILE_BINS + x) * 2;
      stats[j] = Math.round((255 * nonGap) / resolution);
      stats[j + 1] = Math.round(255 * rate);
    }
  }
}

/**
 * How many of the columns in [c0, c0 + width) the hotspot of bucket `b` actually
 * covers. A hot bucket is HOT_SPACING wide but its hotspot is only the first
 * HOT_WIDTH columns of it, so a bin that merely sits in a hot bucket is usually not
 * hot at all. Without this a bin's whole bucket goes dark, which at coarse levels
 * widens a 400-column block into a 20000-column one.
 */
function hotOverlap(b, c0, width) {
  const s = b * HOT_SPACING;
  return Math.max(0, Math.min(c0 + width, s + HOT_WIDTH) - Math.max(c0, s));
}

function fillOverviewModelled({ mean, peak, stats }, startColumn, resolution, firstRow, nRows, columns) {
  const firstBucketOf = (c) => Math.floor(c / HOT_SPACING);
  const hotPerBin = [];
  // The consensus of a column is the same for every row, so both ends of a bin's
  // color ramp are row-independent and worth computing once per bin.
  const matchColor = new Float64Array(TILE_BINS * 3);
  const differColor = new Float64Array(TILE_BINS * 3);
  for (let x = 0; x < TILE_BINS; x++) {
    const c0 = startColumn + x * resolution;
    const list = [];
    for (let b = firstBucketOf(c0); b <= firstBucketOf(c0 + resolution - 1); b++) {
      if (!isHotBucket(b)) continue;
      const overlap = hotOverlap(b, c0, resolution);
      if (overlap > 0) list.push({ bucket: b, overlap });
    }
    hotPerBin.push(list);
    for (let s = 0; s < SAMPLES; s++) {
      const c = Math.floor(c0 + ((s + 0.5) * resolution) / SAMPLES);
      const consensus = Math.floor(hash(c, 4) * 4);
      for (let k = 0; k < 3; k++) {
        matchColor[x * 3 + k] += MATCH_RGB[consensus][k] / SAMPLES;
        differColor[x * 3 + k] += MISMATCH_MEAN_RGB[consensus][k] / SAMPLES;
      }
    }
  }
  for (let y = 0; y < nRows; y++) {
    const r = firstRow + y;
    const base = rowRate(r);
    for (let x = 0; x < TILE_BINS; x++) {
      const c0 = startColumn + x * resolution;
      const mid = c0 + resolution / 2;
      const background = base + regionRate(mid, columns);
      // Hot columns are counted, not hot buckets, so a bin is only as dark as the
      // part of it the hotspot really covers.
      let hotColumns = 0;
      let widest = 0;
      for (const { bucket, overlap } of hotPerBin[x]) {
        if (!rowInHotspot(r, bucket)) continue;
        hotColumns += overlap;
        widest = Math.max(widest, overlap);
      }
      const toward = (fraction) => Math.min(1, background + (HOT_RATE - background) * fraction);
      const meanRate = toward(hotColumns / resolution);
      // `peak` is the worst sub-bin of the width the exact level uses, which makes it
      // the same number at every resolution instead of fading as bins grow.
      const peakRate = toward(Math.min(1, widest / EXACT_RESOLUTION));
      let gaps = 0;
      for (let s = 0; s < SAMPLES; s++) gaps += gapRate(r, c0 + ((s + 0.5) * resolution) / SAMPLES);
      const nonGap = 1 - gaps / SAMPLES;

      const i = (y * TILE_BINS + x) * 4;
      for (let k = 0; k < 3; k++) {
        const match = matchColor[x * 3 + k];
        const differ = differColor[x * 3 + k];
        mean[i + k] = channel(nonGap, match, differ, meanRate, GAP_RGB[k]);
        peak[i + k] = channel(nonGap, match, differ, peakRate, GAP_RGB[k]);
      }
      mean[i + 3] = 255;
      peak[i + 3] = Math.round(255 * peakRate);
      const j = (y * TILE_BINS + x) * 2;
      stats[j] = Math.round(255 * nonGap);
      stats[j + 1] = Math.round(255 * meanRate);
    }
  }
}
