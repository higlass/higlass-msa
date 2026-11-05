// Row sorting: grouping rows by the symbol they carry at one column.
//
// A tile holds 256 adjacent rows of the data, and sorting can move a row arbitrarily
// far, so only the data source can say which rows belong in a block. Sorting therefore
// happens where the data is: the sort state travels in the tile id, the source fills
// each tile row from the row the order puts there, and the track draws the tile exactly
// as it draws an unsorted one.
//
// An order is a permutation with order[displayRow] = sourceRow. The track asks the data
// source for the same permutation, so names, labels and tooltips follow the cells.

export const NO_SORT_KEY = 'u';

/** The sort state as a tile id part, so tiles of two orders can never be confused. */
export function sortKey(sortBy) {
  const { column } = sortBy ?? {};
  return Number.isInteger(column) && column >= 0 ? `c${column}` : NO_SORT_KEY;
}

/** Inverse of sortKey, for a data source reading a tile id. */
export function parseSortKey(key) {
  if (typeof key !== 'string' || key[0] !== 'c') return null;
  const column = Number(key.slice(1));
  return Number.isInteger(column) && column >= 0 ? { column } : null;
}

/**
 * Groups rows by their symbol at one column, in symbol order. The palette numbers the
 * bases first and the gap after them, so bases come first and gaps sink to the bottom.
 * Rows within a group keep the order the data has them in.
 *
 * `symbols[sourceRow]` is the symbol code of that row at the sorted column. The order
 * is always built from the data's own row order, never from the order on screen, so
 * sorting a second column replaces the first sort rather than refining it.
 */
export function orderBySymbol(symbols) {
  const order = Int32Array.from({ length: symbols.length }, (_, row) => row);
  return order.sort((a, b) => symbols[a] - symbols[b] || a - b);
}

/** The source row a display row shows, which is the row itself when unsorted. */
export function sourceRow(order, row) {
  return order ? order[row] : row;
}
