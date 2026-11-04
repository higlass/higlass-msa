// Answers the spike's four questions in a real browser and records frame timings.
// Uses the locally installed Chrome through a temporary profile.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const OUT = 'spike-output';
const WIDTH = 2000;
const HEIGHT = 1100;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const problems = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
});

const summarize = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2);
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};

/** Waits until every visible tile has arrived and been drawn. */
async function settle() {
  await page.waitForFunction(
    () => {
      const t = window.__msaTrack;
      return (
        t?.tilesetInfo &&
        t.visibleTileIds.size > 0 &&
        t.areAllVisibleTilesLoaded() &&
        t.fetching.size === 0
      );
    },
    null,
    { timeout: 180000 },
  );
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await page.waitForTimeout(200);
}

async function open(query) {
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.__msaReady, null, { timeout: 60000 });
  await settle();
}

const span = () =>
  page.evaluate(() => {
    const [a, b] = window.hgApi.getLocation('main').xDomain;
    return b - a;
  });

const visibleCells = () =>
  page.evaluate(() => {
    const t = window.__msaTrack;
    return Object.values(t.fetchedTiles).reduce(
      (sum, tile) => sum + (tile.tileData ? tile.tileData.validBins * tile.tileData.height : 0),
      0,
    );
  });

/** Runs an interaction while recording requestAnimationFrame gaps and Pixi render time. */
async function measure(name, interact, { gpuSync = false } = {}) {
  await page.evaluate((sync) => {
    window.__msaFrames.renderMs.length = 0;
    window.__msaFrames.newTiles.length = 0;
    window.__msaFrames.forceGpuSync = sync;
    window.__raf = [];
    window.__rafOn = true;
    let last = performance.now();
    const tick = (t) => {
      window.__raf.push(t - last);
      last = t;
      if (window.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, gpuSync);
  await interact();
  const r = await page.evaluate(() => {
    window.__rafOn = false;
    window.__msaFrames.forceGpuSync = false;
    return {
      raf: window.__raf.slice(1),
      render: window.__msaFrames.renderMs.slice(),
      newTiles: window.__msaFrames.newTiles.slice(),
    };
  });
  // Frames that uploaded a new tile, separated from frames that only moved quads.
  const withUpload = r.render.filter((_, i) => r.newTiles[i] > 0);
  const withoutUpload = r.render.filter((_, i) => r.newTiles[i] === 0);
  const uploaded = r.newTiles.reduce((a, b) => a + b, 0);
  return {
    name,
    gpuSync,
    frameGapMs: summarize(r.raf),
    renderMs: summarize(r.render),
    framesOver16ms: r.render.filter((x) => x > 16).length,
    noUploadFramesMs: summarize(withoutUpload),
    noUploadFramesOver16ms: withoutUpload.filter((x) => x > 16).length,
    uploadFramesMs: summarize(withUpload),
    tilesUploaded: uploaded,
    msPerUploadedTile: uploaded
      ? +(withUpload.reduce((a, b) => a + b, 0) / uploaded).toFixed(2)
      : null,
  };
}

const pan = (y, amplitude = 300) => async () => {
  await page.mouse.move(WIDTH / 2, y);
  await page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await page.mouse.move(WIDTH / 2 + amplitude * Math.sin(i / 10), y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

async function wheelUntil(direction, reached) {
  await page.mouse.move(WIDTH / 2, 500);
  for (let i = 0; i < 400 && !reached(await span()); i++) {
    await page.mouse.wheel(0, direction * 120);
    await page.waitForTimeout(16);
  }
}

const report = { when: new Date().toISOString(), viewport: [WIDTH, HEIGHT], runs: [] };

// --- Control: the frame rate this browser gives a page that draws nothing
await page.goto('about:blank');
report.blankPageFrameGapMs = summarize(
  await page.evaluate(
    () =>
      new Promise((done) => {
        const gaps = [];
        let last = performance.now();
        const tick = (t) => {
          gaps.push(t - last);
          last = t;
          if (gaps.length < 120) requestAnimationFrame(tick);
          else done(gaps.slice(1));
        };
        requestAnimationFrame(tick);
      }),
  ),
);

// --- Dense view: 1M columns x 1000 rows, every row one pixel tall
await open('columns=1000000&rows=1000&rowHeight=1&height=1000');

report.environment = await page.evaluate(() => {
  const r = window.__msaRenderer;
  const gl = r.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
    pixiRendererType: r.type,
    webGLVersion: r.context.webGLVersion,
    glVersion: gl.getParameter(gl.VERSION),
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unavailable',
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    glError: gl.getError(),
  };
});
report.overviewCellsLoaded = await visibleCells();
await page.screenshot({ path: `${OUT}/1-overview-full.png` });

report.runs.push(await measure('pan, full overview', pan(500)));
report.runs.push(await measure('pan, full overview', pan(500), { gpuSync: true }));
await settle();

report.runs.push(
  await measure('wheel zoom in to 400 columns (tiles loading)', () => wheelUntil(-1, (s) => s <= 400)),
);
await settle();
report.spanAfterZoomIn = await span();
report.rawCellsLoaded = await visibleCells();
await page.screenshot({ path: `${OUT}/2-zoomed-raw-dense.png` });

report.runs.push(await measure('pan, raw dense', pan(500)));
report.runs.push(await measure('pan, raw dense', pan(500), { gpuSync: true }));
await settle();
// Small enough that no new tile is needed, so this isolates the cost of drawing.
report.runs.push(await measure('small pan, raw dense, no new tiles', pan(500, 4), { gpuSync: true }));
await settle();

report.runs.push(
  await measure('wheel zoom out to full (tiles loading)', () => wheelUntil(1, (s) => s >= 999000)),
);
await settle();
await page.screenshot({ path: `${OUT}/5-overview-after-roundtrip.png` });

report.idleRequests = await page.evaluate(async () => {
  const before = window.__msaFetchStats.requests;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return window.__msaFetchStats.requests - before;
});
report.tileIds = await page.evaluate(() => {
  const ids = window.__msaFetchStats.tileIds;
  return {
    total: ids.length,
    unique: new Set(ids).size,
    allThreePart: ids.every((id) => /^\d+\.\d+\.\d+$/.test(id)),
    zLevels: [...new Set(ids.map((id) => +id.split('.')[0]))].sort((a, b) => a - b),
    rowBlocks: [...new Set(ids.map((id) => +id.split('.')[2]))].sort((a, b) => a - b),
  };
});
report.workerBatchMs = summarize(await page.evaluate(() => window.__msaFetchStats.generationMs));
report.textures = await page.evaluate(() => ({
  ...window.__msaStats,
  glError: window.__msaRenderer.gl.getError(),
}));

// --- Letters: tall rows at deep zoom
await open('columns=1000000&rows=64&rowHeight=16&height=800');
await page.evaluate(() => window.hgApi.zoomTo('main', 500000, 500100, 500000, 500100, 0));
await page.waitForTimeout(300);
await settle();
await page.screenshot({ path: `${OUT}/3-letters.png` });
report.runs.push(await measure('pan, letters', pan(400)));
report.runs.push(await measure('pan, letters', pan(400), { gpuSync: true }));

// --- Very long alignment: 1B columns, for precision and level selection
await open('columns=1000000000&rows=1000&rowHeight=1&height=1000');
await page.screenshot({ path: `${OUT}/6-full-1B-columns.png` });
await page.evaluate(() => window.hgApi.zoomTo('main', 999999000, 999999400, 999999000, 999999400, 0));
await page.waitForTimeout(300);
await settle();
await page.screenshot({ path: `${OUT}/4-end-of-1B-columns.png` });
report.longAlignment = await page.evaluate(() => ({
  zLevels: [...new Set(window.__msaFetchStats.tileIds.map((id) => +id.split('.')[0]))],
  lastTileIds: window.__msaFetchStats.tileIds.slice(-3),
  glError: window.__msaRenderer.gl.getError(),
}));

// --- Attribution: same large pans with the axis track removed
await open('columns=1000000&rows=1000&rowHeight=1&height=1000&axis=0');
report.runs.push(await measure('NO AXIS pan, full overview, first', pan(500)));
report.runs.push(await measure('NO AXIS pan, full overview, repeat', pan(500)));
report.runs.push(await measure('NO AXIS pan, full overview', pan(500), { gpuSync: true }));
await settle();
await open('columns=1000000&rows=1000&rowHeight=1&height=1000');
report.runs.push(await measure('WITH AXIS pan, full overview, first', pan(500)));
report.runs.push(await measure('WITH AXIS pan, full overview, repeat', pan(500)));
report.runs.push(await measure('WITH AXIS pan, full overview', pan(500), { gpuSync: true }));

report.problems = [...new Set(problems)].slice(0, 40);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));

await browser.close();
await server.close();
