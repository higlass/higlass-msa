// The one place cell colors are defined.
//
// Column = symbol, row 0 = matches consensus (pale), row 1 = differs (saturated).
// Raw tiles look these up per cell on the GPU. Overview tiles are built by averaging
// the very same colors, so every pixel at every zoom level is a mix of colors that
// exist at the raw level. That is what keeps the zoom levels looking alike.

export const SYMBOLS = ['A', 'C', 'G', 'T', 'N', '-', '', ''];
export const GAP_SYMBOL = 5;
/** Symbols a consensus or a mismatch can take; the rest are gaps and padding. */
export const BASE_SYMBOLS = 4;

export const PALETTE_RGB = [
  [[214, 240, 214], [228, 236, 250], [250, 238, 210], [250, 222, 222], [232, 232, 232], [248, 248, 248], [255, 255, 255], [255, 255, 255]],
  [[46, 160, 67], [40, 110, 220], [235, 150, 20], [215, 45, 45], [120, 120, 120], [248, 248, 248], [255, 255, 255], [255, 255, 255]],
];

export const MATCH_RGB = PALETTE_RGB[0];
export const MISMATCH_RGB = PALETTE_RGB[1];
export const GAP_RGB = MATCH_RGB[GAP_SYMBOL];

/**
 * Average color of a cell that differs from `consensus`, which is the mean of the
 * saturated colors of the other bases. Used when aggregating a bin, where the
 * individual mismatching symbols are no longer resolvable.
 */
export const MISMATCH_MEAN_RGB = Array.from({ length: BASE_SYMBOLS }, (_, consensus) => {
  const mean = [0, 0, 0];
  for (let k = 1; k < BASE_SYMBOLS; k++) {
    const rgb = MISMATCH_RGB[(consensus + k) % BASE_SYMBOLS];
    for (let c = 0; c < 3; c++) mean[c] += rgb[c] / (BASE_SYMBOLS - 1);
  }
  return mean;
});
