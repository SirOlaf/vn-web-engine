import {
  allocateAokanaBitmap,
  cropAokanaBitmap,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {AokanaDisplayObject, type AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

/** CDspObjMap (05F850), the category-one tile display, separate from Landscape. */
export class AokanaDisplayMap extends AokanaDisplayObject {
  private cache: AokanaBitmap | null = null;
  private cachedCells = new Uint16Array(0);
  private selectedCells = new Uint16Array(0);
  private columns = 0;
  private rows = 0;
  private tileWidth = 0;
  private tileHeight = 0;
  private mapCells: Uint16Array | null = null;
  private mapWidth = 0;
  private mapHeight = 0;
  private tileDescriptors: AokanaBitmap[] | null = null;
  private tileSurface = -1;
  private tileImageId = -1;
  private viewEnabled = false;
  private mapX = -1;
  private mapY = -1;
  private view: AokanaBitmapRectangle = {left: -1, top: -1, right: -1, bottom: -1};
  private dirty = false;

  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
    order: number,
  ) {
    super(environment, 1, order, 1);
  }

  /** 05ECA0 resets selection without deleting the independent map-data allocation. */
  private resetView(): void {
    this.viewEnabled = false;
    this.mapX = this.mapY = -1;
    this.view.left = this.view.top = -1;
  }

  /** 05ED20 and 05EDA0: grid/cache and borrowed tile descriptors have separate lifetimes. */
  private releaseGrid(): void {
    this.cache?.storage?.release();
    this.cache = null;
    this.cachedCells = new Uint16Array(0);
    this.selectedCells = new Uint16Array(0);
  }

  override dispose(): void {
    this.check();
    this.tileDescriptors = null;
    this.releaseGrid();
    this.mapCells = null;
    super.dispose();
  }

  /** 05F4F0: viewport cell counts, then cell dimensions; retains existing map data. */
  configureGrid(columns: number, rows: number, tileWidth: number, tileHeight: number): 0 | 2 | 3 {
    this.check();
    columns >>>= 0;
    rows >>>= 0;
    tileWidth >>>= 0;
    tileHeight >>>= 0;
    if ((tileWidth - 1) >>> 0 >= 256 || (tileHeight - 1) >>> 0 >= 256) return 3;
    if (
      columns === 0 ||
      columns > Math.floor(1024 / tileWidth) ||
      rows === 0 ||
      rows > Math.floor(768 / tileHeight)
    )
      return 2;
    if (this.configureGeometry(columns * tileWidth, rows * tileHeight) === 0) return 2;
    this.releaseGrid();
    this.tileDescriptors = null;
    this.resetView();
    this.columns = columns;
    this.rows = rows;
    this.tileWidth = tileWidth;
    this.tileHeight = tileHeight;
    const format = this.environment.compositor.defaultFormat;
    this.cache = allocateAokanaBitmap(
      (columns + 1) * tileWidth,
      (rows + 1) * tileHeight,
      format === 1 ? 2 : format,
    );
    clearAokanaBitmap(this.cache);
    const count = (columns + 1) * (rows + 1);
    this.cachedCells = new Uint16Array(count).fill(0xffff);
    this.selectedCells = new Uint16Array(count);
    return 0;
  }

  /** 05EDF0: descriptors borrow their surface backing and retain its image identity. */
  private setTileSurface(surface: number): boolean {
    if (this.cache === null) return false;
    const source = this.surfaces.snapshot(surface);
    if (source === null) return false;
    const columns = Math.floor((source.width >>> 0) / this.tileWidth);
    const rows = Math.floor((source.height >>> 0) / this.tileHeight);
    if (columns === 0 || rows === 0) return false;
    const compatible =
      source.format === 1 || source.format === 2
        ? this.cache.format === 1 || this.cache.format === 2
        : source.format <= 6 && source.format === this.cache.format;
    if (!compatible) return false;
    this.tileSurface = surface | 0;
    this.tileImageId = this.surfaces.imageId(surface);
    this.tileDescriptors = [];
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < columns; x++) {
        this.tileDescriptors.push({
          ...source,
          offset:
            source.offset +
            y * this.tileHeight * source.stride +
            x * this.tileWidth * source.bytesPerPixel,
          width: this.tileWidth,
          height: this.tileHeight,
        });
      }
    return true;
  }

  /** 05F6D0 publishes position/blend/layer only after tile-source validation succeeds. */
  configure(
    x: number,
    y: number,
    surface: number,
    blendMode: number,
    blendValue: number,
    layer: number,
  ): boolean {
    this.check();
    if (!this.setTileSurface(surface)) return false;
    this.move(x, y);
    this.blendMode = blendMode | 0;
    this.setBlendValue(blendValue);
    this.setLayer(layer);
    return true;
  }

  /** 05F150 forces every selected cell to differ from its cached comparison word. */
  private invalidateAllCells(): void {
    if (this.cache === null) return;
    for (let i = 0; i < this.cachedCells.length; i++) this.cachedCells[i] = ~this.selectedCells[i]!;
  }

  /** 05F440 owns a copied little-endian ushort map, independently of viewport size. */
  replaceMap(width: number, height: number, readBytes: (length: number) => Uint8Array): boolean {
    this.check();
    width >>>= 0;
    height >>>= 0;
    if (width === 0 || height === 0) return false;
    this.mapCells = null;
    this.resetView();
    this.invalidateAllCells();
    this.mapWidth = width;
    this.mapHeight = height;
    const count = Math.imul(width, height) >>> 0;
    const bytes = readBytes(count * 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cells = new Uint16Array(count);
    for (let i = 0; i < count; i++) cells[i] = view.getUint16(i * 2, true);
    this.mapCells = cells;
    return true;
  }

  /** 05F260 reloads cell words only when tile origin changes; wrap alone is not a reload. */
  selectView(mapX: number, mapY: number, pixelX: number, pixelY: number, wrap: number): boolean {
    this.check();
    mapX >>>= 0;
    mapY >>>= 0;
    pixelX >>>= 0;
    pixelY >>>= 0;
    if (
      this.cache === null ||
      this.mapCells === null ||
      mapX >= this.mapWidth ||
      mapY >= this.mapHeight ||
      pixelX >= this.tileWidth ||
      pixelY >= this.tileHeight
    )
      return false;
    if (mapX !== this.mapX || mapY !== this.mapY) {
      this.mapX = mapX;
      this.mapY = mapY;
      if ((wrap | 0) === 0) this.selectedCells.fill(0xffff);
      let sourceY = mapY;
      for (let y = 0; y <= this.rows; y++, sourceY++) {
        if (sourceY >= this.mapHeight) {
          if ((wrap | 0) === 0) break;
          sourceY = 0;
        }
        let sourceX = mapX;
        for (let x = 0; x <= this.columns; x++, sourceX++) {
          if (sourceX >= this.mapWidth) {
            if ((wrap | 0) === 0) break;
            sourceX = 0;
          }
          const word = this.mapCells[(Math.imul(this.mapWidth, sourceY) + sourceX) >>> 0];
          if (word === undefined)
            throw new RangeError('Aokana map reads outside native map allocation');
          this.selectedCells[y * (this.columns + 1) + x] = word;
        }
      }
      this.dirty = true;
    }
    this.view = {
      left: pixelX,
      top: pixelY,
      right: this.columns * this.tileWidth - 1 + pixelX,
      bottom: this.rows * this.tileHeight - 1 + pixelY,
    };
    this.viewEnabled = true;
    return true;
  }

  /** 05F1D0 advances its source word an extra time for each matching cached tile. */
  invalidateTile(tile: number): boolean {
    this.check();
    if (this.cache === null) return false;
    tile >>>= 0;
    let source = 0;
    for (let i = 0; i < this.cachedCells.length; i++, source++) {
      if (this.cachedCells[i] === tile) {
        const word = this.selectedCells[source++];
        if (word === undefined)
          throw new RangeError('Aokana map reads outside native selected-cell allocation');
        this.cachedCells[i] = ~word;
      }
    }
    this.dirty = true;
    return true;
  }

  /** 05EFA0 refreshes changed cells only; expired source identity clears the cache. */
  private refresh(): void {
    if (!this.viewEnabled || this.tileDescriptors === null || this.cache === null) return;
    const surface = this.surfaces.snapshot(this.tileSurface);
    if (surface === null || this.surfaces.imageId(this.tileSurface) !== this.tileImageId) {
      clearAokanaBitmap(this.cache);
      this.dirty = false;
      return;
    }
    for (let y = 0; y <= this.rows; y++)
      for (let x = 0; x <= this.columns; x++) {
        const index = y * (this.columns + 1) + x;
        const cell = this.selectedCells[index]!;
        if (this.cachedCells[index] === cell) continue;
        const invalid = cell === 0xffff || cell >= this.tileDescriptors.length;
        this.environment.compositor.draw(
          this.cache,
          x * this.tileWidth,
          y * this.tileHeight,
          this.tileDescriptors[invalid ? 0 : cell]!,
          invalid ? 0x41 : 0x80,
          0,
        );
        this.cachedCells[index] = cell;
      }
    this.dirty = false;
  }

  /** 05F750 crops the retained cache first to pixel scroll, then the local damage rectangle. */
  override draw(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle, _key: number): void {
    this.check();
    if (!this.viewEnabled || this.tileDescriptors === null || this.cache === null) return;
    if (this.dirty) this.refresh();
    const source = {...this.cache};
    cropAokanaBitmap(source, this.view);
    cropAokanaBitmap(source, rectangle);
    this.environment.compositor.composite(
      destination,
      source,
      this.blendMode,
      this.effectiveBlendValue(),
      true,
    );
  }
}
