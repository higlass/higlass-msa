import { orderBySymbol, parseSortKey } from '../sortRows.js';
import { BLOCK_ROWS, TILE_BINS, columnSymbols, overviewTile, rawTile, resolutions } from './field.js';

// One order per sort column, because every tile of a sorted view needs the same
// permutation and the track asks for it too. In a real tileset this is precomputed by
// the builder; here it costs one cell lookup per row.
const orders = new Map();

function rowOrderFor(sortBy, rows, columns) {
  if (!sortBy) return null;
  const key = `${sortBy.column}|${rows}|${columns}`;
  if (!orders.has(key)) orders.set(key, orderBySymbol(columnSymbols(sortBy.column, rows, columns)));
  return orders.get(key);
}

function buildTiles({ tileIds, columns, rows }) {
  const descending = resolutions(columns).sort((a, b) => b - a);
  const tiles = {};
  const transfer = [];

  for (const tileId of tileIds) {
    const [z, x, rowBlock, sortKeyPart] = tileId.split('.');
    const resolution = descending[Number(z)];
    const startColumn = Number(x) * resolution * TILE_BINS;
    const firstRow = Number(rowBlock) * BLOCK_ROWS;
    const height = Math.min(BLOCK_ROWS, rows - firstRow);
    const validBins = Math.min(TILE_BINS, Math.ceil((columns - startColumn) / resolution));
    if (height <= 0 || validBins <= 0) {
      tiles[tileId] = { tilePositionId: tileId, error: 'Tile out of range' };
      continue;
    }
    const sortBy = parseSortKey(sortKeyPart);
    if (sortBy && (sortBy.column < 0 || sortBy.column >= columns)) {
      tiles[tileId] = { tilePositionId: tileId, error: 'Sort column out of range' };
      continue;
    }
    const order = rowOrderFor(sortBy, rows, columns);

    let payload;
    let kind;
    if (resolution === 1) {
      const tile = rawTile(startColumn, firstRow, height, order);
      tile.fill(columns);
      payload = { data: tile.data };
      kind = 'raw';
    } else {
      const tile = overviewTile(startColumn, resolution, firstRow, height, order);
      tile.fill(columns);
      payload = { mean: tile.mean, peak: tile.peak, stats: tile.stats };
      kind = 'overview';
    }
    for (const array of Object.values(payload)) transfer.push(array.buffer);
    tiles[tileId] = {
      tilePositionId: tileId,
      kind,
      ...payload,
      width: TILE_BINS,
      height,
      validBins,
      z: Number(z),
      x: Number(x),
      rowBlock: Number(rowBlock),
      resolution,
      startColumn,
      sortKey: sortKeyPart,
    };
  }
  return { tiles, transfer };
}

self.onmessage = async ({ data }) => {
  const { id, kind = 'tiles', latencyMs = 0, columns, rows } = data;
  if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  const started = performance.now();

  if (kind === 'order') {
    const order = rowOrderFor(data.sortBy, rows, columns);
    self.postMessage({ id, kind, order, generationMs: performance.now() - started });
    return;
  }

  const { tiles, transfer } = buildTiles(data);
  self.postMessage({ id, kind, tiles, generationMs: performance.now() - started }, transfer);
};
