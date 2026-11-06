// Tiles from a HiGlass-style tile server (resgen-server, higlass-server) holding an
// alignment pre-aggregated by `clodius aggregate msa`. Every zoom level is stored, so
// the server only slices, and every level is an exact average of the cells.
//
//   data: { type: 'msa-server', server: 'http://localhost:8000/api/v1', tilesetUid,
//           coordinates: 'reference' }
//
// coordinates: 'alignment' (default) puts one alignment column at each x. 'reference'
// puts the reference sequence (hg38.chr22, say) on x instead, one base per position
// from 0, so the track lines up with other tracks of that chromosome: columns where
// the reference has a gap are left out, and reference bases in no block are blank.
// The file needs a reference table (clodius.msa.add_reference).

const stats = (window.__msaFetchStats = window.__msaFetchStats || {
  requests: 0,
  orderRequests: 0,
  tileIds: [],
  generationMs: [],
});

/** Ids per request, so the query string stays a sensible length. */
const BATCH = 16;

function bytesOf(base64) {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The server sends mean colors as RGB to save a quarter of the bytes. */
function rgbToRgba(rgb) {
  const n = rgb.length / 3;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function decodeTile(tile) {
  if (!tile || tile.error) return tile ?? { error: 'Missing tile' };
  if (tile.kind === 'raw') return { ...tile, data: bytesOf(tile.data) };
  return {
    ...tile,
    mean: rgbToRgba(bytesOf(tile.mean)),
    peak: bytesOf(tile.peak),
    stats: bytesOf(tile.stats),
  };
}

class ServerFetcher {
  constructor(HGC, dataConfig, pubSub) {
    this.dataConfig = dataConfig;
    this.pubSub = pubSub;
    this.server = dataConfig.server.replace(/\/$/, '');
    this.uid = dataConfig.tilesetUid;
    this.inReference = dataConfig.coordinates === 'reference';
    // The server's tile id suffix for reference coordinates.
    this.suffix = this.inReference ? '.r' : '';
    // Where x = 0 of the tileset sits on the view's x axis: in reference coordinates,
    // the reference chromosome's start in its genome (chr22 starts at 2,824,183,054 in
    // hg38), so the track lines up with whole-genome tracks.
    this.offset = dataConfig.offset ?? 0;
  }

  /** Tiles by the track's ids; the result is keyed by those ids too. */
  async getTiles(ids) {
    const query = ids.map((id) => `d=${encodeURIComponent(`${this.uid}.${id}${this.suffix}`)}`).join('&');
    const response = await fetch(`${this.server}/tiles/?${query}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const tiles = await response.json();
    return Object.fromEntries(
      Object.entries(tiles).map(([fullId, tile]) => [
        fullId.slice(this.uid.length + 1, fullId.length - this.suffix.length),
        tile,
      ]),
    );
  }

  /** In reference coordinates, the track sees the reference's extent and levels. */
  inCoordinates(info) {
    if (info.error) return info;
    const offset = this.offset;
    if (!this.inReference) {
      return { ...info, min_pos: [offset], max_pos: [offset + info.shape[1]], xOffset: offset };
    }
    const reference = info.reference;
    if (!reference) return { error: `Tileset ${this.uid} has no reference table` };
    return {
      ...info,
      resolutions: reference.resolutions,
      min_pos: [offset],
      max_pos: [offset + reference.length],
      max_width: reference.max_width,
      shape: [info.shape[0], reference.length],
      coordinates: 'reference',
      xOffset: offset,
    };
  }

  tilesetInfo(callback) {
    const done = fetch(`${this.server}/tileset_info/?d=${encodeURIComponent(this.uid)}`)
      .then((response) => response.json())
      .then((infos) => this.inCoordinates(infos[this.uid] ?? { error: `No tileset ${this.uid}` }))
      .catch((error) => ({ error: String(error) }));
    done.then((info) => callback?.(info, this.uid));
    return done;
  }

  fetchTilesDebounced(receivedTiles, tileIds) {
    stats.requests++;
    stats.tileIds.push(...tileIds);
    const started = performance.now();
    const batches = [];
    for (let i = 0; i < tileIds.length; i += BATCH) batches.push(tileIds.slice(i, i + BATCH));
    Promise.all(
      batches.map((ids) =>
        this.getTiles(ids).catch((error) => Object.fromEntries(ids.map((id) => [id, { error: String(error) }]))),
      ),
    ).then((responses) => {
      stats.generationMs.push(performance.now() - started);
      const tiles = {};
      for (const response of responses) {
        for (const [id, tile] of Object.entries(response)) {
          const decoded = decodeTile(tile);
          // HiGlass counts tile x from min_pos, the server from 0: same tile, shifted.
          if (!decoded.error) decoded.startColumn += this.offset;
          tiles[id] = { ...decoded, tilePositionId: id };
        }
      }
      receivedTiles(tiles);
    });
  }

  /** Same contract as SyntheticDataFetcher.rowOrder: order[displayRow] = sourceRow. */
  async rowOrder(sortBy) {
    stats.orderRequests++;
    const id = `order.c${sortBy.column - this.offset}`;
    const tile = (await this.getTiles([id]))[id];
    if (!tile || tile.error) return null;
    return new Int32Array(bytesOf(tile.order).buffer);
  }
}

export default function ServerDataFetcher(HGC, ...args) {
  if (!new.target) throw new Error('ServerDataFetcher must be called with "new"');
  return new ServerFetcher(HGC, ...args);
}

ServerDataFetcher.config = { type: 'msa-server' };
