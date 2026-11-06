# Changelog

## Unreleased

- Add the `msa-server` data fetcher for tiles made by `clodius aggregate msa` and
  served by resgen-server or higlass-server
- Add `coordinates: 'reference'` to the `msa-server` fetcher: x is a reference
  position (e.g. hg38) instead of an alignment column; tooltips show positions such
  as `hg38.chr22:25,409,386`
- Add an `offset` option to the `msa-server` fetcher so the track lines up with
  whole-genome tracks
- Demo: `?server=` and `?tileset=` for tile server data, `?coordinates=reference`,
  and `?genome=hg38`, which adds chromosome labels, genes and epilogos from resgen.io
- Sort rows by the symbol at a column, from the right-click menu or the
  `sortByBase` option
- Overview colors are the real average colors of the cells, with a peak color for
  the worst 4-column stretch so rare mismatches stay visible when zoomed out
- Synthetic data: levels up to 64 columns per bin are averaged from real cells, and
  the track warns past 16 columns per bin, where its colors are approximate
- Overview bins are drawn with hard edges, with no blending along x
- Rows stretch to fill the track height, never below `rowHeight`

## 0.0.1

- HiGlass MSA track spike: raw cells with letters, overview levels, row labels that
  thin out when zoomed out, tooltips, and vertical zoom and scroll
