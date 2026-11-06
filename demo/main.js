import 'higlass/dist/hglib.css';
import * as PIXI from 'pixi.js';
import * as hglib from 'higlass';

import register from 'higlass-register';
// The epilogos track (horizontal-stacked-bar) of ?genome=hg38. The package's module
// build exports its tracks without registering them, unlike its script build.
import { StackedBarTrack } from 'higlass-multivec';

import '../src/index.js';

register({ track: StackedBarTrack, config: StackedBarTrack.config });

// URL parameters: ?columns=1000000&rows=1000&rowHeight=1&height=1000&latencyMs=0
//                 &sortColumn=500000&editable=1   (editable=1 enables the right-click menu)
//                 &server=http://localhost:8000/api/v1&tileset=msa-chrM   (tile server data)
//                 &coordinates=reference   (x = reference positions, e.g. hg38, not columns)
//                 &genome=hg38   (whole-genome x, with hg38 chromosome, gene and
//                                 epilogos tracks from resgen.io; implies coordinates=reference)
const params = new URLSearchParams(location.search);
const num = (key, fallback) => (params.has(key) ? +params.get(key) : fallback);

/** Whole-genome tracks to show with the alignment, by assembly. */
const GENOMES = {
  hg38: {
    server: 'https://resgen.io/api/v1',
    chromInfo: 'ZpZ8c5JJRUS1J7ZkofcUrg',
    tracks: [
      {
        type: 'chromosome-labels',
        uid: 'chromosomes',
        tilesetUid: 'ZpZ8c5JJRUS1J7ZkofcUrg',
        server: 'https://resgen.io/api/v1',
        options: {
          color: '#808080',
          stroke: '#ffffff',
          fontSize: 12,
          fontIsLeftAligned: false,
          showMousePosition: false,
          mousePositionColor: '#000000',
          reverseOrientation: false,
          name: 'Chromosome Info (hg38)',
        },
        height: 30,
      },
      {
        type: 'horizontal-gene-annotations',
        uid: 'genes',
        tilesetUid: 'M9A9klpwTci5Vf4bHZ864g',
        server: 'https://resgen.io/api/v1',
        options: {
          fontSize: 10,
          labelColor: 'black',
          labelBackgroundColor: '#ffffff',
          labelPosition: 'hidden',
          minHeight: 24,
          plusStrandColor: 'blue',
          minusStrandColor: 'red',
          trackBorderWidth: 0,
          trackBorderColor: 'black',
          showMousePosition: false,
          mousePositionColor: '#000000',
          geneAnnotationHeight: 16,
          geneLabelPosition: 'outside',
          geneStrandSpacing: 4,
        },
        height: 90,
      },
      {
        type: 'horizontal-stacked-bar',
        uid: 'epilogos',
        tilesetUid: 'HMSJyvLCSgGmrDJctdIz3w',
        server: 'https://resgen.io/api/v1',
        options: {
          labelPosition: 'topLeft',
          labelColor: 'black',
          labelTextOpacity: 0.4,
          valueScaling: 'exponential',
          trackBorderWidth: 0,
          trackBorderColor: 'black',
          backgroundColor: 'white',
          barBorder: true,
          sortLargestOnTop: true,
          selectRows: null,
          name: 'Epilogos (hg38)',
          colorScale: [
            '#FF0000', '#FF4500', '#32CD32', '#008000', '#006400', '#C2E105', '#FFFF00', '#66CDAA',
            '#8A91D0', '#CD5C5C', '#E9967A', '#BDB76B', '#808080', '#C0C0C0', '#FFFFFF',
          ],
        },
        height: 222,
      },
    ],
  },
};

// With a tile server, the alignment's size comes from it rather than the URL.
const server = params.get('server');
const tilesetUid = params.get('tileset');
const genome = GENOMES[params.get('genome')] ?? null;
const coordinates = genome || params.get('coordinates') === 'reference' ? 'reference' : 'alignment';
const serverInfo =
  server && tilesetUid
    ? (await (await fetch(`${server.replace(/\/$/, '')}/tileset_info/?d=${tilesetUid}`)).json())[tilesetUid]
    : null;
if (serverInfo?.error) throw new Error(`Tileset ${tilesetUid}: ${serverInfo.error}`);
if (serverInfo && coordinates === 'reference' && !serverInfo.reference) {
  throw new Error(`Tileset ${tilesetUid} has no reference table`);
}
const columns = serverInfo
  ? coordinates === 'reference'
    ? serverInfo.reference.length
    : serverInfo.shape[1]
  : num('columns', 1_000_000);
const rows = serverInfo ? serverInfo.shape[0] : num('rows', 1000);
const rowHeight = num('rowHeight', 1);
const height = num('height', Math.min(1000, rows * rowHeight));

// In a genome, x is a whole-genome position: the reference chromosome (chr22 of
// hg38.chr22) starts where the chromosomes before it end.
let offset = 0;
let genomeLength = columns;
if (genome && serverInfo) {
  const sizes = (await (await fetch(`${genome.server}/chrom-sizes/?id=${genome.chromInfo}`)).text())
    .trim()
    .split('\n')
    .map((line) => line.split('\t'));
  const chrom = serverInfo.reference.name.split('.').slice(1).join('.');
  const index = sizes.findIndex(([name]) => name === chrom);
  if (index < 0) throw new Error(`${chrom} is not in ${params.get('genome')}`);
  if (+sizes[index][1] !== columns) {
    throw new Error(`${chrom} is ${sizes[index][1]} long in ${params.get('genome')} but ${columns} in the alignment`);
  }
  offset = sizes.slice(0, index).reduce((sum, [, length]) => sum + +length, 0);
  genomeLength = sizes.reduce((sum, [, length]) => sum + +length, 0);
}

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
      initialXDomain: [offset, offset + columns],
      // Narrowest and widest x spans, in columns. Without a minimum, HiGlass zooms
      // until a single column is billions of pixels wide.
      zoomLimits: [20, genomeLength],
      layout: { w: 12, h: 12, x: 0, y: 0 },
      tracks: {
        top: [
          // In a genome, the chromosome labels track is the axis.
          ...(params.get('axis') === '0' || genome ? [] : [{ uid: 'axis', type: 'top-axis', height: 24 }]),
          ...(genome && serverInfo ? genome.tracks : []),
          {
            uid: 'msa',
            type: 'msa',
            height,
            data: serverInfo
              ? { type: 'msa-server', server, tilesetUid, coordinates, offset }
              : { type: 'msa-synthetic', columns, rows, latencyMs: num('latencyMs', 0) },
            options: {
              rowHeight,
              firstRow: num('firstRow', 0),
              rowLabelImportance: params.get('labelImportance') ?? 'length',
              sortByBase: params.has('sortColumn') ? { column: offset + num('sortColumn', 0) } : null,
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
