# Spike results

Run with `npm run spike` (needs Node 20+, see `.nvmrc`). Raw output and screenshots go to `spike-output/`.

**Setup:** HiGlass 2.3.5, Pixi 6.5.10, Chrome 131 headless, WebGL2 on Apple M1 Pro, 2000x1100 at device scale 1. Data is synthetic, from a worker. Each scenario ran once per script run, so treat the numbers as indicative.

## Assumptions checked

| Question | Result | Consequence |
|---|---|---|
| Can raw cells use a one-byte texture? | Yes. `FORMATS.RED` renders correctly on WebGL2 with no GL errors. | Raw data costs 1 byte per cell. The WebGL1 `LUMINANCE` fallback is written but untested. |
| Can tile IDs carry a row block? | Yes. Overriding `setVisibleTiles` gives `z.x.rowBlock`, and the base classes treat the ID as an opaque string. | No need to manage tiles inside the track. |
| Does the 4x level scheme need a zoom override? | No. `tilesetInfo.resolutions` supports it natively and picks the finest level with bins wider than one pixel. | Drop the planned `calculateZoomLevel` override. |
| Do row blocks fit the texture limit? | Yes. Blocks are 256x256 and the limit here is 16384. | Not a concern at this block size. |

## Frame cost

Render times wait for the GPU through a 1x1 readback. Up to about 1M cells were loaded (977,000 overview, 768,000 raw).

| Scenario | Median | p95 | Frames over 16 ms |
|---|---|---|---|
| Small pan, raw, no new tiles | 4.5 ms | 6.8 ms | 0 of 120 |
| Large pan, raw | 4.7 ms | 13.4 ms | 4 of 122 |
| Large pan, letters | 4.6 ms | 10.9 ms | 2 of 120 |
| Large pan, overview, after a first pan | 4.3 ms | 7.5–8 ms | 1 of 120 |

The display-rate median was 16.7 ms in every scenario, the same as a blank page.

## Other measurements

- **Tile upload:** usually 0.5–1.6 ms per tile. Frames that uploaded a batch reached about 6 ms per tile (4 tiles in one frame), and one frame hit about 20 ms per tile (12 tiles, 240 ms). That frame was the first to use the raw shader, so shader compilation is the likely cause, but this wasn't isolated.
- **Levels:** all six levels for 1M columns were displayed. 1B columns selects level 11 of 11 at the far end and renders with no visible precision problems.
- **Idle:** no tile requests while idle.

## Findings that change the plan

1. **`zoomLimits` is required.** Without a minimum span, HiGlass zoomed until the view was about 1e-7 columns wide, far past the point where a column is useful to draw.
2. **A tile cache is needed.** The base classes discard off-screen tiles, so 332 tile requests covered only 168 unique tiles.
3. **Stale requests must be cancelled.** The worker works through its queue even after the user has moved on. Synthetic batches took several seconds at worst, which delays the tiles the user is actually looking at.

## Correction: track alignment

The frame-cost numbers above were measured with tiles misplaced. `pMain` was never moved to the track position, so everything sat 29 px too high and about 5 px too far left, and the early screenshots that looked correct were not. This is fixed and covered by `npm run test:browser`.

A re-run after the fix and the vertical zoom work was slightly slower in places: medians of 4.7–6.6 ms, and p95 up to 19 ms on a large raw pan (was 13.4 ms). With one run per scenario, this could be noise.

## Row labels

Labels are one canvas texture on one quad, redrawn only when the visible rows or their size change. A first version using one `BitmapText` per label took x-pan frames from 5.3 ms to 43.4 ms with about 97 labels, so it was replaced.

### Importance

`src/labelLevels.js` precomputes candidate labels for each zoom level, plus each row's rank. Level L holds rows at least 2^L apart, picked most important first from level L - 1. So levels are nested. With equal importance, level L is exactly the multiples of 2^L.

`placeLabels` in `src/rowLabels.js` makes the final choice whenever row height or scroll changes. It takes candidates from two levels finer than an even stride would need, then places them in pixels: labels already showing first, then the rest by rank, skipping any that overlap. Placing takes about 0.04 ms with 1M rows.

Set with the `rowLabelImportance` track option: `'length'` uses name length, and `'none'` uses `tilesetInfo.rowImportance` if present, otherwise equal importance. Building 1M rows took about 650 ms and about 1.8M entries. At 1 px rows the demo shows 71 labels, all long names, up from 35 with precomputed levels alone.

Live placement gives up some guarantees. Zooming in only adds labels, and labels stay while they remain in view. Zooming out can occasionally add one: a simulated 14-step sweep added 1 or 2, and the real-wheel check on 1000 rows added none. Which labels show can depend on how you got there: scrolling away and back gave a different set in a simulation with equal importance.

Row scroll p95 with labels, three runs each: 31.7, 27.5, 34.6 ms live; 44.6, 27.4, 35.8 ms before. The 33 ms limit failed one run live and two before, so this shows no slowdown.

Measured at the row height that fits the most labels (about 10 px), waiting for the GPU, from one representative run. Numbers vary between runs.

| Action | Median, on / off | p95, on / off |
|---|---|---|
| X pan, labels unchanged | 3.6 / 5.3 ms | 14.9 / 12.7 ms |
| Row scroll | 5.8 / 5.1 ms | 15.5 / 7.5 ms |
| Shift zoom | 6.9 / 6.2 ms | 17.7 / 9 ms |

X pan adds no measurable cost. Scrolling and zooming do cost something at p95, because each redraw re-uploads the canvas. Redraw JS is about 1 ms at the median and 4 ms at p95. This table predates label thinning and the shift+drag fix below.

### Thinning labels when zoomed out

Originally only rows at multiples of a power of two were labelled, with the power chosen so labels couldn't overlap. Live placement (above) replaced that choice, and overlap is now checked in pixels. Every row is labelled from 10 px rows up. With equal importance at 1 px rows, every 16th row is labelled, about 63 labels in 1000 px.

This first replaced importance-based greedy hiding, the approach in `TextManager`. In a simulated zoom-out over 1000 rows, with hashed importance and no history, greedy hiding made 1,026 labels newly appear, so names swap as you zoom out. Nested multiples made none. Pileup's `TextManager` reduces this by favoring labels that were already visible, but then what's shown depends on the zoom path. `placeLabels` now accepts that same trade. HiGlass's own `TextManager` isn't exported and depends on bed track internals.

Each label now has its own background rather than sharing a full-height column, because a permanent column would hide the first 7% of a fully zoomed-out alignment on a 2000 px track.

### Double scroll on shift+drag

HiGlass 2.3.5 calls `movedY` twice per mouse event during shift+drag, so a 48 px drag scrolled 96 px. `movedY` now ignores repeat calls within one event. Over 12 rounds of scrolling, the slowest frame fell from 135–245 ms to 32–69 ms. Slow frames still occur in the test suite, see below.

## Row sorting

Right-clicking a column offers "Sort rows by column N", the MSA counterpart of higlass-pileup's sort by base. The track option is `sortByBase: { column }`, and `null` is the order the data is in. The menu item appears only when the data source can sort, which it says by having a `rowOrder` method.

**Where the sorting happens.** A tile holds 256 adjacent rows, and sorting can move a row into any other block, so only the data source can say which rows belong in a block. Pileup sorts inside its track because it already holds every read of the view; this track holds textures, so sorting goes to the source.

**Tile ids carry the sort.** Remote ids go from `z.x.rowBlock` to `z.x.rowBlock.sortKey`, the key being `u` or `c<column>`. The tiles of two orders are then different tiles: changing the sort refetches, both orders stay in HiGlass's cache, and a tile still in flight from the old order can't be taken for a new one.

**The order comes to the track too,** as `order[displayRow] = sourceRow` from `dataFetcher.rowOrder(sortBy)`, one request per sort rather than one per tile. The track draws the per-row text itself, so without it names, labels and tooltips would sit beside the wrong cells. Label levels are rebuilt when the order changes, because sorting changes which name is on which row.

**Grouping.** Rows are grouped by their symbol at the column, in palette order, which puts the bases first and sinks gaps to the bottom. Rows inside a group keep the data's order. The order is always built from the data's order, so sorting a second column replaces the first sort instead of refining it.

**Editable views only.** HiGlass hides the right-click track menu when the view config says `editable: false` (`TiledPlot.isTrackMenuDisabled`), so the demo takes `?editable=1`. `?sortColumn=N` opens straight into a sorted view.

**Cost.** The synthetic source reads one cell per row to build an order and caches it per column, which is free at demo sizes. A real tileset would precompute it, and a sorted fetch reads scattered rows instead of one contiguous block.

Covered by `test/sortRows.test.js` and `scripts/test-sort-by-base.mjs`, which drives the real right-click menu.

## Open questions
- **Slow frames with labels on:** frames of 80–550 ms still appear in most test runs, more often with labels on, and redraw JS has peaked at about 150 ms. Some also appear with labels off, up to about 320 ms, so not all of this is label cost. They move between rounds, so it isn't first-use warm-up. Neither `willReadFrequently` nor a canvas readback made a clear difference. The p95 limit of 33 ms in `test-row-labels.mjs` fails intermittently because of this.

- **First-pan stutter:** the first large pan after load has 7–9 frames over 16 ms and gaps up to about 470 ms. Later pans are clean. New tiles and the axis track are both ruled out, and JIT warm-up is only a guess.
- **Isolated outlier:** one 234 ms frame and one 649 ms frame gap in a later run, with cause unknown.
- **30 fps first run:** the very first benchmark run had a 33 ms median frame gap in every scenario, including a letters pan that never overshot the zoom. The three later runs all had 16.7 ms. That run predates the harness fixes, and the cause wasn't identified.

## Not covered yet

- Real data, real tile decoding and network latency.
- Aggregation rules. Overview tiles come from an analytic function, so they say nothing about the real aggregates.
- High-DPI displays, which draw about 4x the fragments at device scale 2.
- Other GPUs, integrated or software rendering, Firefox and Safari.
- Row pooling and vertical scrolling. `firstRow` is only an option for now.

## Known noise

HiGlass logs a React warning about importing `createRoot` from `react-dom`, plus a Pixi warning from its renderer setup. Neither has caused a visible problem so far.
