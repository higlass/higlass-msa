// Deterministic stand-in for a real alignment, used to exercise rendering only.
//
// Raw tiles are per-cell samples of this field. Overview tiles are computed from
// the same field analytically rather than aggregated from raw cells, so they look
// consistent across zoom levels but do NOT validate the aggregation rules. That is
// the job of the real builder.

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

function fillRaw(data, startColumn, firstRow, nRows, columns) {
  for (let y = 0; y < nRows; y++) {
    const r = firstRow + y;
    const base = rowRate(r);
    for (let x = 0; x < TILE_BINS; x++) {
      const c = startColumn + x;
      const consensus = Math.floor(hash(c, 4) * 4);
      let byte;
      if (hash(r * 31 + 11, c) < gapRate(r, c)) {
        byte = 5;
      } else {
        const bucket = Math.floor(c / HOT_SPACING);
        const hot = c % HOT_SPACING < HOT_WIDTH && isHotBucket(bucket) && rowInHotspot(r, bucket);
        const rate = hot ? HOT_RATE : base + regionRate(c, columns);
        if (hash(r * 31 + 7, c) < rate) {
          const sym = (consensus + 1 + Math.floor(hash(r * 17 + 3, c) * 3)) % 4;
          byte = sym | 8;
        } else {
          byte = consensus;
        }
      }
      data[y * TILE_BINS + x] = byte;
    }
  }
}

export function fillOverview(data, startColumn, resolution, firstRow, nRows, columns) {
  const firstBucketOf = (c) => Math.floor(c / HOT_SPACING);
  const hotPerBin = [];
  for (let x = 0; x < TILE_BINS; x++) {
    const c0 = startColumn + x * resolution;
    const list = [];
    for (let b = firstBucketOf(c0); b <= firstBucketOf(c0 + resolution - 1); b++) {
      if (isHotBucket(b)) list.push(b);
    }
    hotPerBin.push(list);
  }
  const hotDensity = Math.min(1, HOT_WIDTH / (resolution / 16));
  for (let y = 0; y < nRows; y++) {
    const r = firstRow + y;
    const base = rowRate(r);
    for (let x = 0; x < TILE_BINS; x++) {
      const c0 = startColumn + x * resolution;
      const mid = c0 + resolution / 2;
      const background = base + regionRate(mid, columns);
      let hotCount = 0;
      for (const b of hotPerBin[x]) if (rowInHotspot(r, b)) hotCount++;
      const mean = background + (hotCount * HOT_WIDTH * HOT_RATE) / resolution;
      const peak = hotCount > 0 ? Math.max(background, HOT_RATE * hotDensity) : background;
      let gaps = 0;
      for (let s = 0; s < 8; s++) gaps += gapRate(r, c0 + ((s + 0.5) * resolution) / 8);
      const i = (y * TILE_BINS + x) * 4;
      data[i] = 255 * (1 - gaps / 8);
      data[i + 1] = 255 * Math.min(1, mean);
      data[i + 2] = 255 * Math.min(1, peak);
      data[i + 3] = Math.floor(hash(Math.floor(mid), 4) * 4);
    }
  }
}
