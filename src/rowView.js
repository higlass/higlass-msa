// Vertical viewport of the track: how tall rows are drawn and how far they are scrolled.
//
//   k       multiplier on the base row height, never below 1
//   offset  y of the top of row 0, in track pixels, never above 0

export function clampOffset(offset, rowPx, rows, height) {
  const lowest = Math.min(0, height - rows * rowPx);
  return Math.min(0, Math.max(offset, lowest));
}

/**
 * Zooms about yPos, keeping the row under the cursor in place.
 * Follows the HiGlass convention: a kMultiplier below 1 enlarges rows.
 */
export function zoomRows(view, { yPos, kMultiplier, rowHeight, maxRowHeight, rows, height }) {
  const maxK = Math.max(1, maxRowHeight / rowHeight);
  const k = Math.min(maxK, Math.max(1, view.k / kMultiplier));
  const rowAtCursor = (yPos - view.offset) / (rowHeight * view.k);
  const rowPx = rowHeight * k;
  return { k, offset: clampOffset(yPos - rowAtCursor * rowPx, rowPx, rows, height) };
}

export function panRows(view, { dY, rowHeight, rows, height }) {
  return {
    k: view.k,
    offset: clampOffset(view.offset + dY, rowHeight * view.k, rows, height),
  };
}

/** Inclusive range of rows intersecting the track, or null if there are none. */
export function visibleRows(offset, rowPx, rows, height) {
  const first = Math.max(0, Math.floor(-offset / rowPx));
  const last = Math.min(rows - 1, Math.ceil((height - offset) / rowPx) - 1);
  return last >= first ? [first, last] : null;
}

/** Letters fade in as the cell's smaller side grows, so both directions must have room. */
export function letterAlpha(cellWidthPx, cellHeightPx, fadeStart = 7, fadeEnd = 10) {
  const t = (Math.min(cellWidthPx, cellHeightPx) - fadeStart) / (fadeEnd - fadeStart);
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}
