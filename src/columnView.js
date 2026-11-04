// Horizontal viewport of the track: how much of the alignment one screen pixel covers,
// and what that implies for drawing bins that hold more than one column.

const smoothstep = (t) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * How far a bin may be pushed from its mean color towards its peak color, 0 to 1.
 *
 * A bin's mean color is honest but hides rare mismatches: one differing cell in a
 * thousand columns averages away. The push back towards the peak fades out as bins
 * approach a column per pixel, so the coarsest overview and the raw level meet
 * without a step. Both end colors are real raw-level colors, so the hues never change.
 */
export function mismatchEmphasis(columnsPerPixel, fadeStart = 1, fadeEnd = 16) {
  return smoothstep((columnsPerPixel - fadeStart) / (fadeEnd - fadeStart));
}

/**
 * How much neighbouring bins are blended along x, 0 (hard edges) to 1 (linear).
 *
 * Bins wider than a couple of pixels read as blocks, and the blocks are re-cut every
 * time the zoom level changes, which is most of what makes the change look abrupt.
 * Narrow bins stay sharp instead, because there a single bin can be the only trace
 * left of a hotspot.
 */
export function binSmoothing(pixelsPerBin, fadeStart = 1, fadeEnd = 3) {
  return smoothstep((pixelsPerBin - fadeStart) / (fadeEnd - fadeStart));
}
