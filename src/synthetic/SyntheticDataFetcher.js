import { TILE_BINS, resolutions, rowName } from './field.js';

const stats = (window.__msaFetchStats = window.__msaFetchStats || {
  requests: 0,
  tileIds: [],
  generationMs: [],
});

class SyntheticFetcher {
  constructor(HGC, dataConfig, pubSub) {
    this.dataConfig = dataConfig;
    this.pubSub = pubSub;
    this.pending = new Map();
    this.nextId = 0;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data: { id, tiles, generationMs } }) => {
      stats.generationMs.push(generationMs);
      const receivedTiles = this.pending.get(id);
      this.pending.delete(id);
      receivedTiles(tiles);
    };
  }

  tilesetInfo(callback) {
    const { columns, rows } = this.dataConfig;
    const info = {
      resolutions: resolutions(columns),
      bins_per_dimension: TILE_BINS,
      tile_size: TILE_BINS,
      min_pos: [0],
      max_pos: [columns],
      shape: [rows, columns],
      rowNames: Array.from({ length: rows }, (_, r) => rowName(r)),
    };
    // Deferred so the track's constructor finishes before the first refreshTiles().
    Promise.resolve().then(() => callback?.(info, 'synthetic'));
    return info;
  }

  fetchTilesDebounced(receivedTiles, tileIds) {
    const id = this.nextId++;
    stats.requests++;
    stats.tileIds.push(...tileIds);
    this.pending.set(id, receivedTiles);
    const { columns, rows, latencyMs } = this.dataConfig;
    this.worker.postMessage({ id, tileIds, columns, rows, latencyMs });
  }
}

export default function SyntheticDataFetcher(HGC, ...args) {
  if (!new.target) throw new Error('SyntheticDataFetcher must be called with "new"');
  return new SyntheticFetcher(HGC, ...args);
}

SyntheticDataFetcher.config = { type: 'msa-synthetic' };
