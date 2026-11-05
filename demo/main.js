import 'higlass/dist/hglib.css';
import * as PIXI from 'pixi.js';
import * as hglib from 'higlass';

import '../src/index.js';

// URL parameters: ?columns=1000000&rows=1000&rowHeight=1&height=1000&latencyMs=0
//                 &sortColumn=500000&editable=1   (editable=1 enables the right-click menu)
const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) ? +params.get(key) : fallback);
const columns = num('columns', 1_000_000);
const rows = num('rows', 1000);
const rowHeight = num('rowHeight', 1);
const height = num('height', Math.min(1000, rows * rowHeight));

// Records JS time spent in each Pixi frame and captures the renderer for inspection.
// With forceGpuSync on, a 1x1 readback makes each frame wait for the GPU, so the
// recorded time includes the GPU work rather than only the JS that submits it.
const frames = (window.__msaFrames = { renderMs: [], newTiles: [], forceGpuSync: false });
const originalRender = PIXI.Renderer.prototype.render;
const pixel = new Uint8Array(4);
let tilesAtLastFrame = 0;
PIXI.Renderer.prototype.render = function timedRender(...args) {
  window.__msaRenderer = this;
  const tiles = window.__msaStats?.tilesInitialized ?? 0;
  const started = performance.now();
  const result = originalRender.apply(this, args);
  if (frames.forceGpuSync) {
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixel);
  }
  frames.renderMs.push(performance.now() - started);
  frames.newTiles.push(tiles - tilesAtLastFrame);
  tilesAtLastFrame = tiles;
  return result;
};

const viewConfig = {
  // HiGlass only shows the right-click track menu, which is where row sorting lives,
  // when the view is editable (TiledPlot.isTrackMenuDisabled). Off by default here so
  // the demo has no editing chrome around the track.
  editable: params.get('editable') === '1',
  zoomFixed: false,
  views: [
    {
      uid: 'main',
      initialXDomain: [0, columns],
      // Narrowest and widest x spans, in columns. Without a minimum, HiGlass zooms
      // until a single column is billions of pixels wide.
      zoomLimits: [20, columns],
      layout: { w: 12, h: 12, x: 0, y: 0 },
      tracks: {
        top: [
          ...(params.get('axis') === '0' ? [] : [{ uid: 'axis', type: 'top-axis', height: 24 }]),
          {
            uid: 'msa',
            type: 'msa',
            height,
            data: { type: 'msa-synthetic', columns, rows, latencyMs: num('latencyMs', 0) },
            options: {
              rowHeight,
              firstRow: num('firstRow', 0),
              rowLabelImportance: params.get('labelImportance') ?? 'length',
              sortByBase: params.has('sortColumn') ? { column: num('sortColumn', 0) } : null,
            },
          },
        ],
      },
    },
  ],
};

window.hgApi = await hglib.viewer(document.getElementById('hg'), viewConfig, {
  sizeMode: 'bounded' === params.get('sizeMode') ? 'bounded' : 'default',
});
window.__msaReady = true;
