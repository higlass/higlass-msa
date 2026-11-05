import { TILE_BINS, resolutions, rowName } from './field.js';

const stats = (window.__msaFetchStats = window.__msaFetchStats || {
  requests: 0,
  orderRequests: 0,
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
    this.worker.onmessage = ({ data: { id, kind, tiles, order, generationMs } }) => {
      stats.generationMs.push(generationMs);
      const resolve = this.pending.get(id);
      this.pending.delete(id);
      resolve(kind === 'order' ? order : tiles);
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
    this.worker.postMessage({ id, kind: 'tiles', tileIds, columns, rows, latencyMs });
  }

  /**
   * The row order the tiles of `sortBy` are built with, as order[displayRow] =
   * sourceRow. The track needs it for everything it draws per row itself: names,
   * labels and tooltips. A data source without this method cannot sort, and the track
   * then offers no sort menu item.
   */
  rowOrder(sortBy) {
    const { columns, rows, latencyMs } = this.dataConfig;
    const id = this.nextId++;
    stats.orderRequests++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, kind: 'order', sortBy, columns, rows, latencyMs });
    });
  }
}

export default function SyntheticDataFetcher(HGC, ...args) {
  if (!new.target) throw new Error('SyntheticDataFetcher must be called with "new"');
  return new SyntheticFetcher(HGC, ...args);
}

SyntheticDataFetcher.config = { type: 'msa-synthetic' };
