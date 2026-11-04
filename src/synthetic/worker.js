import { BLOCK_ROWS, TILE_BINS, fillOverview, rawTile, resolutions } from './field.js';

self.onmessage = async ({ data: { id, tileIds, columns, rows, latencyMs = 0 } }) => {
  if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  const descending = resolutions(columns).sort((a, b) => b - a);
  const tiles = {};
  const transfer = [];
  const started = performance.now();

  for (const tileId of tileIds) {
    const [z, x, rowBlock] = tileId.split('.').map(Number);
    const resolution = descending[z];
    const startColumn = x * resolution * TILE_BINS;
    const firstRow = rowBlock * BLOCK_ROWS;
    const height = Math.min(BLOCK_ROWS, rows - firstRow);
    const validBins = Math.min(TILE_BINS, Math.ceil((columns - startColumn) / resolution));
    if (height <= 0 || validBins <= 0) {
      tiles[tileId] = { tilePositionId: tileId, error: 'Tile out of range' };
      continue;
    }

    let data;
    let kind;
    if (resolution === 1) {
      const tile = rawTile(startColumn, firstRow, height);
      tile.fill(columns);
      data = tile.data;
      kind = 'raw';
    } else {
      data = new Uint8Array(TILE_BINS * height * 4);
      fillOverview(data, startColumn, resolution, firstRow, height, columns);
      kind = 'overview';
    }
    transfer.push(data.buffer);
    tiles[tileId] = {
      tilePositionId: tileId,
      kind,
      data,
      width: TILE_BINS,
      height,
      validBins,
      z,
      x,
      rowBlock,
      resolution,
      startColumn,
    };
  }

  self.postMessage({ id, tiles, generationMs: performance.now() - started }, transfer);
};
