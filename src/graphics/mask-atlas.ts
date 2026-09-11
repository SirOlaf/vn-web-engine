/** Shelf packing with a transparent edge pixel around each independently sampled
 * tile. Page order does not determine composition order. */
export interface MaskTile {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export function packMaskTiles(
  sizes: readonly {width: number; height: number}[],
  limit: number,
): MaskTile[] {
  if (!Number.isSafeInteger(limit) || limit < 3) throw new Error('Invalid mask atlas limit');
  let page = 0,
    x = 0,
    y = 0,
    rowHeight = 0;
  return sizes.map((size) => {
    const width = Math.ceil(size.width),
      height = Math.ceil(size.height);
    if (
      !Number.isFinite(width + height) ||
      size.width < 1 ||
      size.height < 1 ||
      width + 2 > limit ||
      height + 2 > limit
    )
      throw new Error('Mask tile exceeds atlas limits');
    if (x + width + 2 > limit) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    if (y + height + 2 > limit) {
      page++;
      x = 0;
      y = 0;
      rowHeight = 0;
    }
    const tile = {page, x: x + 1, y: y + 1, width, height};
    x += width + 2;
    rowHeight = Math.max(rowHeight, height + 2);
    return tile;
  });
}
