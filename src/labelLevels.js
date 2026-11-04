// Decides, once, which row labels are worth considering at each zoom level. The final
// choice is made from these on screen, in rowLabels.js.
//
// Level L holds rows at least 2^L apart. It is picked greedily, most important row
// first, from the rows of level L - 1, which gives:
//  - no overlap: rows in a level are far enough apart by construction,
//  - stable zooming: each level is a subset of the one below, so zooming out only
//    removes labels and zooming in only adds them,
//  - importance: a row is only ever removed by a row at least as important,
//  - no large holes: neighbors in level L are under 2^(L + 2) rows apart.
//
// Ties go to multiples of the largest power of two, so with equal importance level L
// is exactly the multiples of 2^L.

function trailingZeros(row) {
  return row === 0 ? 32 : 31 - Math.clz32(row & -row);
}

function nextLevel(rows, spacing, rowCount) {
  // Rows in a level are at least `spacing` apart, so each bucket holds at most one.
  const buckets = new Int32Array(Math.floor(rowCount / spacing) + 1).fill(-1);
  const kept = [];
  for (const row of rows) {
    const b = Math.floor(row / spacing);
    const clash = (i) => i >= 0 && i < buckets.length && buckets[i] >= 0 && Math.abs(buckets[i] - row) < spacing;
    if (!clash(b - 1) && !clash(b) && !clash(b + 1)) {
      buckets[b] = row;
      kept.push(row);
    }
  }
  return kept;
}

/**
 * Returns { levels, rank }. `levels` is one sorted Int32Array of rows per level, and
 * `rank[row]` is the row's place in the order of preference, 0 being the most wanted.
 * Higher importance values win.
 */
export function buildLabelIndex(importance) {
  const rowCount = importance.length;
  if (rowCount === 0) return { levels: [], rank: new Int32Array(0) };
  const priority = Int32Array.from({ length: rowCount }, (_, i) => i).sort(
    (a, b) => importance[b] - importance[a] || trailingZeros(b) - trailingZeros(a) || a - b,
  );
  const rank = new Int32Array(rowCount);
  priority.forEach((row, i) => {
    rank[row] = i;
  });
  const levels = [Int32Array.from({ length: rowCount }, (_, i) => i)];
  let current = priority;
  for (let spacing = 2; current.length > 1; spacing *= 2) {
    current = nextLevel(current, spacing, rowCount);
    levels.push(Int32Array.from(current).sort());
  }
  return { levels, rank };
}

export function buildLabelLevels(importance) {
  return buildLabelIndex(importance).levels;
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The rows of a level within [from, to]. */
export function rowsInRange(levels, level, from, to) {
  if (!levels.length) return new Int32Array(0);
  const sorted = levels[Math.min(level, levels.length - 1)];
  return sorted.subarray(lowerBound(sorted, Math.ceil(from)), lowerBound(sorted, Math.floor(to) + 1));
}
