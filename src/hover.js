const BLOCK_ROWS = 256;
const SYMBOL_NAMES = ['A', 'C', 'G', 'T', 'N', 'gap'];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HiGlass inserts tooltip strings as HTML, and row names come from input files. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Reads one cell from a tile, or returns null if the position isn't in this tile. */
export function cellAt(tile, column, row) {
  const x = Math.floor((column - tile.startColumn) / tile.resolution);
  const y = row - tile.rowBlock * BLOCK_ROWS;
  if (x < 0 || x >= tile.validBins || y < 0 || y >= tile.height) return null;
  const firstColumn = tile.startColumn + x * tile.resolution;
  const lastColumn = firstColumn + tile.resolution - 1;

  if (tile.kind === 'raw') {
    const byte = tile.data[y * tile.width + x];
    return { kind: 'raw', column: firstColumn, symbol: SYMBOL_NAMES[byte & 7], mismatch: (byte & 8) !== 0 };
  }

  const bin = y * tile.width + x;
  return {
    kind: 'overview',
    firstColumn,
    lastColumn,
    nonGap: tile.stats[bin * 2] / 255,
    mismatch: tile.stats[bin * 2 + 1] / 255,
    peak: tile.peak[bin * 4 + 3] / 255,
  };
}

const percent = (fraction) => `${(fraction * 100).toFixed(1)}%`;
const count = (n) => n.toLocaleString('en-US');

/**
 * A null cell means the hover is on the label column or the tile hasn't loaded.
 * With `reference` (a name such as hg38.chr22), x is a 0-based position on it, shown
 * 1-based as genome browsers do. `offset` is where the tileset's x = 0 sits on the
 * view's axis, taken off before showing a position.
 */
export function tooltipHtml(name, cell, reference = null, offset = 0) {
  const lines = [`<b>${escapeHtml(name)}</b>`];
  const where = (firstX, lastX = firstX) => {
    const [first, last] = [firstX - offset, lastX - offset];
    return reference
      ? `${escapeHtml(reference)}:${count(first + 1)}${last > first ? `–${count(last + 1)}` : ''}`
      : last > first
        ? `Columns ${count(first)}–${count(last)}`
        : `Column ${count(first)}`;
  };
  if (cell?.kind === 'raw') {
    lines.push(where(cell.column));
    const consensus = cell.symbol === 'gap' ? '' : cell.mismatch ? ' (differs from consensus)' : ' (matches consensus)';
    lines.push(`${cell.symbol}${consensus}`);
  } else if (cell?.kind === 'overview') {
    lines.push(where(cell.firstColumn, cell.lastColumn));
    lines.push(`Non-gap: ${percent(cell.nonGap)}`);
    lines.push(`Mismatch: ${percent(cell.mismatch)}, peak ${percent(cell.peak)}`);
  }
  return lines.join('<br>');
}
