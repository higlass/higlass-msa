// Text decisions for the row label column. Drawing lives in MsaTrack.

import { rowsInRange } from './labelLevels.js';

export const MIN_FONT_PX = 8;
export const MAX_FONT_PX = 14;

export function labelFontSize(rowPx) {
  return Math.round(Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, rowPx * 0.75)));
}

/** Fits a name into maxChars, counting whole characters rather than UTF-16 units. */
export function labelText(name, maxChars) {
  const chars = [...String(name)];
  if (chars.length <= maxChars) return chars.join('');
  if (maxChars <= 1) return maxChars === 1 ? '…' : '';
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/** Height a label occupies, including its background. */
export function labelBoxPx(fontPx) {
  return fontPx * 1.25;
}

/** Tallest possible label box, for margins that must not change with zoom. */
export const MAX_LABEL_BOX_PX = Math.ceil(labelBoxPx(MAX_FONT_PX));

/**
 * Smallest evenly spaced stride that rules out overlap, as a power of two. Placement
 * can pack labels closer than this, so it only sizes the candidate list.
 *
 * Row 0's label is moved down to stay inside the alignment (see labelY), by up to
 * (box - rowPx) / 2, so the spacing allows for that.
 */
export function labelStride(rowPx) {
  const box = labelBoxPx(labelFontSize(rowPx));
  const minSpacing = box + Math.max(0, (box - rowPx) / 2);
  let stride = 1;
  while (stride * rowPx < minSpacing) stride *= 2;
  return stride;
}

/** Center of a row's label, measured from the top of row 0. */
export function labelY(row, rowPx) {
  const center = (row + 0.5) * rowPx;
  return row === 0 ? Math.max(center, labelBoxPx(labelFontSize(rowPx)) / 2) : center;
}

// Levels finer than the even stride, so candidates are closer together than a label.
const CANDIDATE_LEVELS_BELOW_STRIDE = 2;

/**
 * Picks labels that don't overlap, sorted by row. Labels already showing go first so
 * they don't flicker, then the rest by rank.
 */
export function placeLabels(candidates, rank, previous, rowPx) {
  const box = labelBoxPx(labelFontSize(rowPx));
  const order = [...candidates].sort((a, b) => previous.has(b) - previous.has(a) || rank[a] - rank[b]);
  // Placed labels are at least a box apart, so each bucket holds at most one.
  const taken = new Map();
  const placed = [];
  for (const row of order) {
    const y = labelY(row, rowPx);
    const bucket = Math.floor(y / box);
    const clash = (b) => taken.has(b) && Math.abs(taken.get(b) - y) < box - 1e-9;
    if (!clash(bucket - 1) && !clash(bucket) && !clash(bucket + 1)) {
      taken.set(bucket, y);
      placed.push(row);
    }
  }
  return placed.sort((a, b) => a - b);
}

/** Labelled rows that may touch the track, given the labels showing until now. */
export function visibleLabels({ levels, rank }, offset, rowPx, height, previous = new Set()) {
  const level = Math.max(0, Math.log2(labelStride(rowPx)) - CANDIDATE_LEVELS_BELOW_STRIDE);
  const box = labelBoxPx(labelFontSize(rowPx));
  // Generous at the top: row 0's label sits lower than its row center.
  const from = (-box - offset) / rowPx - 0.5;
  const to = (height + box / 2 - offset) / rowPx - 0.5;
  return placeLabels(rowsInRange(levels, level, from, to), rank, previous, rowPx);
}
