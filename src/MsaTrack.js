import { cellAt, tooltipHtml } from './hover.js';
import { buildLabelIndex } from './labelLevels.js';
import { MAX_LABEL_BOX_PX, labelBoxPx, labelFontSize, labelText, labelY, visibleLabels } from './rowLabels.js';
import { clampOffset, letterAlpha, panRows, visibleRows, zoomRows } from './rowView.js';
import { OVERVIEW_FRAGMENT, RAW_FRAGMENT, VERTEX } from './shaders.js';

const BLOCK_ROWS = 256;
const DEFAULT_MAX_ROW_HEIGHT = 48;
const LABEL_PADDING = 4;
const LABEL_FONT_FAMILY = 'Menlo, Consolas, monospace';
const LABEL_LAYER_Z = 1e6;
const LABEL_BACKGROUND_ALPHA = 0.6;
const LABEL_BACKGROUND_ALPHA_OVER_LETTERS = 0.96;
const SYMBOLS = ['A', 'C', 'G', 'T', 'N', '-', '', ''];

// Column = symbol, row 0 = matches consensus (pale), row 1 = differs (saturated).
const PALETTE_RGB = [
  [[214, 240, 214], [228, 236, 250], [250, 238, 210], [250, 222, 222], [232, 232, 232], [248, 248, 248], [255, 255, 255], [255, 255, 255]],
  [[46, 160, 67], [40, 110, 220], [235, 150, 20], [215, 45, 45], [120, 120, 120], [248, 248, 248], [255, 255, 255], [255, 255, 255]],
];

function makePalette(PIXI) {
  const bytes = new Uint8Array(8 * 2 * 4);
  PALETTE_RGB.forEach((row, y) =>
    row.forEach(([r, g, b], x) => bytes.set([r, g, b, 255], (y * 8 + x) * 4)),
  );
  return new PIXI.BaseTexture(new PIXI.BufferResource(bytes, { width: 8, height: 2 }), {
    scaleMode: PIXI.SCALE_MODES.NEAREST,
    mipmap: PIXI.MIPMAP_MODES.OFF,
    alphaMode: PIXI.ALPHA_MODES.NPM,
  });
}

function makeAtlas(PIXI) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size * SYMBOLS.length;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${size * 0.82}px Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  SYMBOLS.forEach((s, i) => ctx.fillText(s, (i + 0.5) * size, size * 0.54));
  return PIXI.BaseTexture.from(canvas, {
    scaleMode: PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF,
    alphaMode: PIXI.ALPHA_MODES.NPM,
  });
}

const stats = (window.__msaStats = window.__msaStats || {
  tilesInitialized: 0,
  tilesDestroyed: 0,
  liveTextureBytes: 0,
  zoomLevelsSeen: {},
  badTileIds: [],
});

function createTrackClass(HGC) {
  const { PIXI } = HGC.libraries;

  return class MsaTrackClass extends HGC.tracks.HorizontalTiled1DPixiTrack {
    constructor(context, options) {
      super(context, options);
      window.__msaTrack = this;
      this.pMain.sortableChildren = true;
      this.quad = new PIXI.Geometry()
        .addAttribute('aVertexPosition', [0, 0, 1, 0, 1, 1, 0, 1], 2)
        .addIndex([0, 1, 2, 0, 2, 3]);
      this.palette = makePalette(PIXI);
      this.atlas = makeAtlas(PIXI);
      this.singleChannelFormat =
        document.createElement('canvas').getContext('webgl2') ? PIXI.FORMATS.RED : PIXI.FORMATS.LUMINANCE;
      const { rowHeight = 1, firstRow = 0 } = options;
      this.rowView = { k: 1, offset: -firstRow * rowHeight };
      this.listenForShiftWheel(context);

      this.labelLayer = new PIXI.Container();
      this.labelLayer.zIndex = LABEL_LAYER_Z;
      this.labelLayer.visible = false;
      this.labelSprite = new PIXI.Sprite();
      this.labelLayer.addChild(this.labelSprite);
      this.pMain.addChild(this.labelLayer);
      this.labelCanvas = document.createElement('canvas');
      this.labelRows = [];
    }

    rowName(row) {
      return this.tilesetInfo.rowNames?.[row] ?? `Row ${row}`;
    }

    /** Which rows may get labels, and in what order. Built once per importance source. */
    getLabelIndex(rows) {
      const { rowLabelImportance = 'none' } = this.options;
      const source = `${rowLabelImportance},${rows}`;
      if (source !== this.labelLevelsSource) {
        this.labelLevelsSource = source;
        this.labelDrawKey = null;
        this.labelPlaced = new Set();
        const importance =
          rowLabelImportance === 'length'
            ? Array.from({ length: rows }, (_, row) => [...this.rowName(row)].length)
            : (this.tilesetInfo.rowImportance ?? new Uint8Array(rows));
        this.labelIndex = buildLabelIndex(importance);
      }
      return this.labelIndex;
    }

    /**
     * Labels at the track's left edge, unaffected by horizontal pan and zoom.
     * All names share one canvas texture, so they are a single quad to draw and cost
     * nothing until the labelled rows or their size change.
     */
    updateRowLabels() {
      if (!this.labelLayer || !this.tilesetInfo) return;
      const { showRowLabels = true, rowLabelWidth = Infinity } = this.options;
      const { rowPx } = this;
      const { offset } = this.rowView;
      const { rows, height, maxRowHeight } = this.rowGeometry();
      const width = Math.min(rowLabelWidth ?? Infinity, this.dimensions?.[0] ?? 0);

      const index = showRowLabels ? this.getLabelIndex(rows) : null;
      // Letters showing through would make names unreadable, so cover them as they fade in.
      const columnPx = this._xScale ? this._xScale(1) - this._xScale(0) : 0;
      const background = (
        LABEL_BACKGROUND_ALPHA +
        (LABEL_BACKGROUND_ALPHA_OVER_LETTERS - LABEL_BACKGROUND_ALPHA) * letterAlpha(columnPx, rowPx)
      ).toFixed(2);
      this.labelBackground = `rgba(255, 255, 255, ${background})`;

      const key = [showRowLabels, width, rowPx, offset, height, rows, this.labelLevelsSource, background].join();
      if (key === this.labelKey) return;
      this.labelKey = key;

      const labels = index ? visibleLabels(index, offset, rowPx, height, this.labelPlaced) : [];
      this.labelPlaced = new Set(labels);
      this.labelLayer.visible = labels.length > 0;
      if (!labels.length) return;

      // Scrolling that keeps the same labels on screen only needs to move the sprite.
      const canvasHeight = Math.ceil(height + 2 * Math.max(rowPx, maxRowHeight) + 2 * MAX_LABEL_BOX_PX);
      const first = labels[0];
      const drawKey = [labels.join(' '), rowPx, width, canvasHeight, background].join();
      if (drawKey !== this.labelDrawKey) {
        this.labelDrawKey = drawKey;
        this.drawLabelCanvas(labels, width, canvasHeight);
      }
      this.labelSprite.y = Math.round(offset + first * rowPx) - MAX_LABEL_BOX_PX;
    }

    /** Names are shown in full unless they are wider than `maxWidth`. */
    drawLabelCanvas(rows, maxWidth, canvasHeight) {
      const dpr = window.devicePixelRatio || 1;
      const canvas = this.labelCanvas;
      const { rowPx } = this;
      const fontPx = labelFontSize(rowPx);
      const box = labelBoxPx(fontPx);
      const font = `${fontPx}px ${LABEL_FONT_FAMILY}`;
      const ctx = canvas.getContext('2d');
      ctx.font = font;
      const maxChars = Math.floor((maxWidth - 2 * LABEL_PADDING) / ctx.measureText('M').width);
      const labels = rows.map((row) => {
        const text = labelText(this.rowName(row), maxChars);
        return { row, text, right: 2 * LABEL_PADDING + ctx.measureText(text).width };
      });

      // Only ever grows, so zooming doesn't keep replacing the texture.
      const widest = Math.max(...labels.map((l) => l.right));
      const pixelWidth = Math.max(canvas.width, Math.ceil(widest * dpr));
      const pixelHeight = Math.ceil(canvasHeight * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        this.labelSprite.texture?.destroy(true);
        this.labelSprite.texture = PIXI.Texture.from(canvas, {
          scaleMode: PIXI.SCALE_MODES.LINEAR,
          mipmap: PIXI.MIPMAP_MODES.OFF,
          resolution: dpr,
        });
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width / dpr, canvasHeight);
      ctx.font = font;
      ctx.textBaseline = 'middle';

      // Each label has its own background so the cells between labels stay visible.
      this.labelRows = [];
      this.labelBox = box;
      const top = rows[0] * rowPx - MAX_LABEL_BOX_PX;
      for (const { row, text, right } of labels) {
        const y = labelY(row, rowPx) - top;
        ctx.fillStyle = this.labelBackground;
        ctx.fillRect(0, y - box / 2, right, box);
        ctx.fillStyle = '#222';
        ctx.fillText(text, LABEL_PADDING, y);
        this.labelRows.push({ row, text, y, right });
      }
      this.labelSprite.texture.baseTexture.update();
    }

    /** The label drawn at a track position, if any. */
    labelAt(trackX, trackY) {
      if (!this.labelLayer.visible) return null;
      const y = trackY - this.labelSprite.y;
      return this.labelRows.find((l) => trackX < l.right && Math.abs(y - l.y) <= this.labelBox / 2) ?? null;
    }

    getMouseOverHtml(trackX, trackY) {
      const { showTooltip = true } = this.options;
      if (!showTooltip || !this.tilesetInfo || !this._xScale) return '';
      // A label can cover several thin rows, and it's the label being pointed at.
      const label = this.labelAt(trackX, trackY);
      if (label) return tooltipHtml(this.rowName(label.row), null);
      const { rows } = this.rowGeometry();
      const row = Math.floor((trackY - this.rowView.offset) / this.rowPx);
      if (row < 0 || row >= rows) return '';

      const column = Math.floor(this._xScale.invert(trackX));
      // While zooming, an older tile can still cover this spot, so take the finest.
      let cell = null;
      let cellZoom = -1;
      for (const tile of Object.values(this.fetchedTiles)) {
        const d = tile.tileData;
        if (!d?.data || d.z <= cellZoom) continue;
        const found = cellAt(d, column, row);
        if (found) {
          cell = found;
          cellZoom = d.z;
        }
      }
      return tooltipHtml(this.rowName(row), cell);
    }

    /**
     * HiGlass routes shift+wheel through d3-zoom, which emits nothing when the wheel
     * can't change the x scale. With zoomLimits set, that would block row zoom at
     * both x limits, so we intercept the event before d3 sees it.
     */
    listenForShiftWheel({ baseEl, svgElement }) {
      if (!baseEl || !svgElement) return;
      this.wheelEl = baseEl;
      this.onWheel = (event) => {
        if (!event.shiftKey || !this.tilesetInfo) return;
        const rect = svgElement.getBoundingClientRect();
        const x = event.clientX - rect.left - this.position[0];
        const y = event.clientY - rect.top - this.position[1];
        const [width, height] = this.dimensions;
        if (x < 0 || y < 0 || x > width || y > height) return;
        event.preventDefault();
        event.stopPropagation();
        // Browsers may report shift+wheel as horizontal. Same formula as HiGlass.
        const delta = event.deltaY || event.deltaX;
        this.zoomedY(y, 2 ** ((delta * (event.deltaMode ? 120 : 1)) / 500));
      };
      this.wheelEl.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    }

    rowGeometry() {
      const { rowHeight = 1, maxRowHeight = DEFAULT_MAX_ROW_HEIGHT } = this.options;
      return {
        rowHeight,
        maxRowHeight,
        rows: this.tilesetInfo.shape[0],
        height: this.dimensions?.[1] ?? 0,
      };
    }

    get rowPx() {
      return (this.options.rowHeight ?? 1) * this.rowView.k;
    }

    /** Shift+wheel, routed here by HiGlass. Enlarges rows around the cursor. */
    zoomedY(yPos, kMultiplier) {
      if (!this.tilesetInfo) return;
      this.applyRowView(zoomRows(this.rowView, { ...this.rowGeometry(), yPos, kMultiplier }));
    }

    /**
     * Vertical drag, routed here by HiGlass. For shift+drag, HiGlass 2.3.5 calls this
     * twice per mouse event (TrackRenderer.zoomed has no return after its first
     * valueScaleMove), so repeat calls within the same event are ignored.
     */
    movedY(dY) {
      if (!this.tilesetInfo || this.movedThisEvent) return;
      this.movedThisEvent = true;
      queueMicrotask(() => {
        this.movedThisEvent = false;
      });
      this.applyRowView(panRows(this.rowView, { ...this.rowGeometry(), dY }));
    }

    applyRowView(view) {
      this.rowView = view;
      this.refreshTilesDebounced();
      this.draw();
      this.animate();
    }

    reclampRowView() {
      const { rows, height } = this.rowGeometry();
      this.rowView.offset = clampOffset(this.rowView.offset, this.rowPx, rows, height);
    }

    /** HiGlass supplies [zoom, x]; we add the row block, giving remote ids of z.x.rowBlock. */
    setVisibleTiles(tilePositions) {
      const blocks = this.visibleRowBlocks();
      super.setVisibleTiles(tilePositions.flatMap((p) => blocks.map((r) => [...p, r])));
    }

    visibleRowBlocks() {
      const { rows, height } = this.rowGeometry();
      const range = visibleRows(this.rowView.offset, this.rowPx, rows, height);
      if (!range) return [];
      const blocks = [];
      for (let r = Math.floor(range[0] / BLOCK_ROWS); r <= Math.floor(range[1] / BLOCK_ROWS); r++) {
        blocks.push(r);
      }
      return blocks;
    }

    initTile(tile) {
      const d = tile.tileData;
      if (!d || d.error) return;
      const isRaw = d.kind === 'raw';
      const base = new PIXI.BaseTexture(
        new PIXI.BufferResource(d.data, { width: d.width, height: d.height }),
        {
          format: isRaw ? this.singleChannelFormat : PIXI.FORMATS.RGBA,
          type: PIXI.TYPES.UNSIGNED_BYTE,
          scaleMode: PIXI.SCALE_MODES.NEAREST,
          mipmap: PIXI.MIPMAP_MODES.OFF,
          wrapMode: PIXI.WRAP_MODES.CLAMP,
          alphaMode: PIXI.ALPHA_MODES.NPM,
        },
      );
      const shader = PIXI.Shader.from(VERTEX, isRaw ? RAW_FRAGMENT : OVERVIEW_FRAGMENT, {
        uData: base,
        uPalette: this.palette,
        uAtlas: this.atlas,
        uDims: new Float32Array([d.width, d.height]),
        uUvScale: new Float32Array([d.validBins / d.width, 1]),
        uCellPx: new Float32Array([1, 1]),
        uLetterAlpha: 0,
      });
      tile.msaMesh = new PIXI.Mesh(this.quad, shader);
      tile.msaTexture = base;
      tile.graphics.addChild(tile.msaMesh);
      tile.graphics.zIndex = d.z;

      stats.tilesInitialized++;
      stats.liveTextureBytes += d.data.byteLength;
      stats.zoomLevelsSeen[d.z] = d.resolution;
      if (!/^\d+\.\d+\.\d+$/.test(tile.remoteId)) stats.badTileIds.push(tile.remoteId);
      this.positionTile(tile);
    }

    positionTile(tile) {
      const d = tile.tileData;
      if (!tile.msaMesh || !this._xScale) return;
      const { rowPx } = this;
      const x0 = this._xScale(d.startColumn);
      const x1 = this._xScale(d.startColumn + d.validBins * d.resolution);
      const mesh = tile.msaMesh;
      mesh.position.set(x0, d.rowBlock * BLOCK_ROWS * rowPx + this.rowView.offset);
      mesh.scale.set(x1 - x0, d.height * rowPx);
      if (d.kind === 'raw') {
        const pxPerCell = (x1 - x0) / d.validBins;
        mesh.shader.uniforms.uCellPx[0] = pxPerCell;
        mesh.shader.uniforms.uCellPx[1] = rowPx;
        mesh.shader.uniforms.uLetterAlpha = letterAlpha(pxPerCell, rowPx);
      }
    }

    destroyTile(tile) {
      if (!tile?.msaMesh) return;
      stats.tilesDestroyed++;
      stats.liveTextureBytes -= tile.tileData.data.byteLength;
      tile.msaMesh.destroy();
      tile.msaTexture.destroy();
      tile.msaMesh = null;
    }

    draw() {
      super.draw();
      for (const tile of Object.values(this.fetchedTiles)) this.positionTile(tile);
      this.updateRowLabels();
    }

    zoomed(newXScale, newYScale) {
      this.xScale(newXScale);
      this.yScale(newYScale);
      this.refreshTilesDebounced();
      this.draw();
    }

    /** The base class moves the mask but not pMain, which holds the tiles. */
    setPosition(newPosition) {
      super.setPosition(newPosition);
      [this.pMain.position.x, this.pMain.position.y] = this.position;
    }

    setDimensions(newDimensions) {
      super.setDimensions(newDimensions);
      if (this.tilesetInfo) {
        this.reclampRowView();
        this.refreshTiles();
        this.updateRowLabels();
      }
    }

    rerender(options, force) {
      super.rerender(options, force);
      this.options = options;
      if (this.tilesetInfo) {
        this.reclampRowView();
        this.refreshTiles();
      }
      this.draw();
    }

    remove() {
      this.wheelEl?.removeEventListener('wheel', this.onWheel, { capture: true });
      this.labelSprite.texture?.destroy(true);
      this.labelLayer.destroy({ children: true });
      super.remove();
      this.palette.destroy();
      this.atlas.destroy();
      this.quad.dispose();
    }
  };
}

let TrackClass = null;

export default function MsaTrack(HGC, ...args) {
  if (!new.target) throw new Error('MsaTrack must be called with "new"');
  TrackClass = TrackClass || createTrackClass(HGC);
  return new TrackClass(...args);
}

MsaTrack.config = {
  type: 'msa',
  datatype: ['msa'],
  orientation: '1d-horizontal',
  local: true,
  availableOptions: ['rowHeight', 'maxRowHeight', 'firstRow', 'showRowLabels', 'rowLabelWidth', 'rowLabelImportance', 'showTooltip'],
  defaultOptions: {
    rowLabelImportance: 'none',
    rowHeight: 1,
    maxRowHeight: DEFAULT_MAX_ROW_HEIGHT,
    firstRow: 0,
    showRowLabels: true,
    showTooltip: true,
  },
};
