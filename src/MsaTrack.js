import { binSmoothing, mismatchEmphasis } from './columnView.js';
import { cellAt, tooltipHtml } from './hover.js';
import { buildLabelIndex } from './labelLevels.js';
import { PALETTE_RGB, SYMBOLS } from './palette.js';
import { MAX_LABEL_BOX_PX, labelBoxPx, labelFontSize, labelText, labelY, visibleLabels } from './rowLabels.js';
import { clampOffset, letterAlpha, panRows, visibleRows, zoomRows } from './rowView.js';
import { OVERVIEW_FRAGMENT, RAW_FRAGMENT, VERTEX } from './shaders.js';
import { NO_SORT_KEY, sortKey, sourceRow } from './sortRows.js';

const BLOCK_ROWS = 256;
const DEFAULT_MAX_ROW_HEIGHT = 48;
const LABEL_PADDING = 4;
const LABEL_FONT_FAMILY = 'Menlo, Consolas, monospace';
const LABEL_LAYER_Z = 1e6;
const LABEL_BACKGROUND_ALPHA = 0.6;
const LABEL_BACKGROUND_ALPHA_OVER_LETTERS = 0.96;

/** Raw tiles hold one byte per cell; overview tiles hold two colors plus tooltip stats. */
const tileBytes = (d) =>
  d.kind === 'raw' ? d.data.byteLength : d.mean.byteLength + d.peak.byteLength + d.stats.byteLength;

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
      this.rowOrder = null;
      this.rowOrderKey = NO_SORT_KEY;
      this.rowOrderVersion = 0;
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

    /** The data row a row of the track shows, which differs from it only when sorted. */
    sourceRow(row) {
      return sourceRow(this.rowOrder, row);
    }

    rowName(row) {
      const source = this.sourceRow(row);
      return this.tilesetInfo.rowNames?.[source] ?? `Row ${source}`;
    }

    /** Which rows may get labels, and in what order. Built once per importance source. */
    getLabelIndex(rows) {
      const { rowLabelImportance = 'none' } = this.options;
      // Sorting moves every name to a different row, so the levels are rebuilt with it.
      const source = `${rowLabelImportance},${rows},${this.rowOrderVersion}`;
      if (source !== this.labelLevelsSource) {
        this.labelLevelsSource = source;
        this.labelDrawKey = null;
        this.labelPlaced = new Set();
        const given = this.tilesetInfo.rowImportance;
        const importance =
          rowLabelImportance === 'length'
            ? Array.from({ length: rows }, (_, row) => [...this.rowName(row)].length)
            : given
              ? Array.from({ length: rows }, (_, row) => given[this.sourceRow(row)])
              : new Uint8Array(rows);
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
        if (!d || d.error || d.z <= cellZoom) continue;
        const found = cellAt(d, column, row);
        if (found) {
          cell = found;
          cellZoom = d.z;
        }
      }
      return tooltipHtml(this.rowName(row), cell);
    }

    /** The column under a track position, or null if there isn't one. */
    columnAt(trackX) {
      if (!this.tilesetInfo || !this._xScale || Number.isNaN(trackX)) return null;
      const column = Math.floor(this._xScale.invert(trackX));
      return column >= 0 && column < this.tilesetInfo.shape[1] ? column : null;
    }

    /** Right-click menu: sorting the rows by the column clicked, as in higlass-pileup. */
    contextMenuItems(trackX) {
      const column = this.columnAt(trackX);
      // Only the data source can reorder rows, because a tile is a block of adjacent
      // rows and sorting moves rows between blocks. One that can't says so by having
      // no rowOrder, and then there is nothing to offer.
      if (column === null || typeof this.dataFetcher?.rowOrder !== 'function') return [];
      const items = [
        {
          label: `Sort rows by column ${column.toLocaleString('en-US')}`,
          onClick: (event, onTrackOptionsChanged) => onTrackOptionsChanged({ sortByBase: { column } }),
        },
      ];
      if (sortKey(this.options.sortByBase) !== NO_SORT_KEY) {
        items.push({
          label: 'Clear row sorting',
          onClick: (event, onTrackOptionsChanged) => onTrackOptionsChanged({ sortByBase: null }),
        });
      }
      return items;
    }

    /**
     * Picks up a change to the sortByBase option. The tiles take care of themselves:
     * the sort key is part of their id, so changing it makes the tiles on screen the
     * wrong ones and HiGlass fetches the right ones. What has to be fetched here is the
     * order itself, for the names the track draws and reports.
     */
    updateRowOrder() {
      const sortBy = this.options.sortByBase ?? null;
      const key = sortKey(sortBy);
      if (key === this.rowOrderKey) return;
      this.rowOrderKey = key;
      // The order in hand belongs to the tiles being replaced, so it goes now rather
      // than when the new one lands: an unsorted name is better than a wrong one.
      this.setRowOrder(null);
      if (key === NO_SORT_KEY || typeof this.dataFetcher?.rowOrder !== 'function') return;
      Promise.resolve(this.dataFetcher.rowOrder(sortBy)).then((order) => {
        // Sorting may have changed again while this was in flight.
        if (this.rowOrderKey === key) this.setRowOrder(order);
      });
    }

    setRowOrder(order) {
      if (!order && !this.rowOrder) return;
      this.rowOrder = order?.length ? order : null;
      this.rowOrderVersion++;
      if (!this.tilesetInfo) return;
      this.updateRowLabels();
      this.draw();
      this.animate();
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

    /**
     * HiGlass supplies [zoom, x]; we add the row block and the sort key, giving remote
     * ids of z.x.rowBlock.sortKey. The sort key is in the id so that the tiles of two
     * orders are different tiles: changing the sort refetches, both orders stay cached,
     * and a tile still in flight from the old order can't be mistaken for a new one.
     */
    setVisibleTiles(tilePositions) {
      const blocks = this.visibleRowBlocks();
      const key = sortKey(this.options.sortByBase);
      super.setVisibleTiles(tilePositions.flatMap((p) => blocks.map((r) => [...p, r, key])));
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

    /** Sampling stays NEAREST: the overview shader interpolates along x itself. */
    makeTileTexture(data, { width, height }, format) {
      return new PIXI.BaseTexture(new PIXI.BufferResource(data, { width, height }), {
        format,
        type: PIXI.TYPES.UNSIGNED_BYTE,
        scaleMode: PIXI.SCALE_MODES.NEAREST,
        mipmap: PIXI.MIPMAP_MODES.OFF,
        wrapMode: PIXI.WRAP_MODES.CLAMP,
        alphaMode: PIXI.ALPHA_MODES.NPM,
      });
    }

    initTile(tile) {
      const d = tile.tileData;
      if (!d || d.error) return;
      const isRaw = d.kind === 'raw';
      tile.msaTextures = isRaw
        ? [this.makeTileTexture(d.data, d, this.singleChannelFormat)]
        : [
            this.makeTileTexture(d.mean, d, PIXI.FORMATS.RGBA),
            this.makeTileTexture(d.peak, d, PIXI.FORMATS.RGBA),
          ];
      const shader = PIXI.Shader.from(VERTEX, isRaw ? RAW_FRAGMENT : OVERVIEW_FRAGMENT, {
        uData: tile.msaTextures[0],
        uMean: tile.msaTextures[0],
        uPeak: tile.msaTextures[tile.msaTextures.length - 1],
        uPalette: this.palette,
        uAtlas: this.atlas,
        uDims: new Float32Array([d.width, d.height]),
        uUvScale: new Float32Array([d.validBins / d.width, 1]),
        uCellPx: new Float32Array([1, 1]),
        uLetterAlpha: 0,
        uEmphasis: 0,
        uSmooth: 0,
      });
      tile.msaMesh = new PIXI.Mesh(this.quad, shader);
      tile.graphics.addChild(tile.msaMesh);
      tile.graphics.zIndex = d.z;

      stats.tilesInitialized++;
      stats.liveTextureBytes += tileBytes(d);
      stats.zoomLevelsSeen[d.z] = d.resolution;
      if (!/^\d+\.\d+\.\d+\.(u|c\d+)$/.test(tile.remoteId)) stats.badTileIds.push(tile.remoteId);
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
      const pxPerBin = (x1 - x0) / d.validBins;
      if (d.kind === 'raw') {
        mesh.shader.uniforms.uCellPx[0] = pxPerBin;
        mesh.shader.uniforms.uCellPx[1] = rowPx;
        mesh.shader.uniforms.uLetterAlpha = letterAlpha(pxPerBin, rowPx);
      } else {
        // Columns per pixel barely changes when HiGlass steps to the next zoom level,
        // because resolution and bin width step together. Driving the emphasis from it
        // instead of from the level keeps the look continuous across the step.
        mesh.shader.uniforms.uEmphasis = mismatchEmphasis(d.resolution / pxPerBin);
        mesh.shader.uniforms.uSmooth = binSmoothing(pxPerBin);
      }
    }

    destroyTile(tile) {
      if (!tile?.msaMesh) return;
      stats.tilesDestroyed++;
      stats.liveTextureBytes -= tileBytes(tile.tileData);
      tile.msaMesh.destroy();
      for (const texture of tile.msaTextures) texture.destroy();
      tile.msaTextures = [];
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

    /** The options can already carry a sort, so the order is wanted straight away. */
    tilesetInfoReceived() {
      super.tilesetInfoReceived();
      this.updateRowOrder();
    }

    rerender(options, force) {
      super.rerender(options, force);
      this.options = options;
      this.updateRowOrder();
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
  availableOptions: ['rowHeight', 'maxRowHeight', 'firstRow', 'showRowLabels', 'rowLabelWidth', 'rowLabelImportance', 'showTooltip', 'sortByBase'],
  defaultOptions: {
    rowLabelImportance: 'none',
    rowHeight: 1,
    maxRowHeight: DEFAULT_MAX_ROW_HEIGHT,
    firstRow: 0,
    showRowLabels: true,
    showTooltip: true,
    // { column } groups the rows by their symbol at that alignment column; null is the
    // order the data is in. Set from the right-click menu.
    sortByBase: null,
  },
};
