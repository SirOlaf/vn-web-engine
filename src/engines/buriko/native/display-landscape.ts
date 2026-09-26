import {
  allocateBurikoBitmap,
  cropBurikoBitmap,
  intersectBurikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {clearBurikoBitmap, copyBurikoBitmapRows} from './bitmap-copy.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';
import {BurikoDisplayObject, type BurikoDisplayObjectEnvironment} from './display-object.js';
import type {BurikoSurfaces} from './surfaces.js';
import {nativeQuickSort} from './record-sort.js';

export type LandscapeWords = (index: number) => number;
interface Chip {
  bitmap: BurikoBitmap;
  pending: boolean;
  dependents: number[];
}
interface Terrain {
  parts: number[];
  top: number;
  bitmap: BurikoBitmap;
  mask: BurikoBitmap | null;
  offsetX: number;
  cover: number;
  extraLayer: number;
}
interface Cell {
  terrain: number;
  rectangle: BurikoBitmapRectangle;
  key: number;
  overlays: number[];
  levels: number[];
  colorMode: number;
  colorLevel: number;
  color: number;
}
interface Row {
  cells: Cell[];
  minimum: number;
  maximum: number;
}
const EMPTY = 0xffffffff;
const blankCell = (): Cell => ({
  terrain: 0,
  rectangle: {left: 0, top: 0, right: 0, bottom: 0},
  key: 0,
  overlays: [0, 0, 0, 0],
  levels: [0, 0, 0, 0],
  colorMode: 0,
  colorLevel: 0,
  color: 0,
});

/** CDspObjLandscape, 05EBA0; owns composed terrain, cell rows and four overlay channels. */
export class BurikoDisplayLandscape extends BurikoDisplayObject {
  readonly pitchX: number;
  readonly pitchY: number;
  readonly stackStep: number;
  readonly halfWidth: number;
  readonly baseline: number;
  readonly rowLayer: number;
  readonly stackLayer: number;
  private chips: Chip[] = [];
  private terrains: Terrain[] = [];
  private overlays: BurikoBitmap[] = [];
  private rows: Row[] | null = null;
  private columns = 0;
  private copiedCells: Uint32Array | null = null;
  private initialized = false;

  constructor(
    environment: BurikoDisplayObjectEnvironment,
    readonly surfaces: BurikoSurfaces,
    order: number,
    width: number,
    rowStep: number,
    stackStep: number,
    baseline: number,
    rowLayer: number,
    stackLayer: number,
  ) {
    super(environment, 1, order, 1);
    this.pitchX = width === 0 || (width & 1) !== 0 ? 64 : width >>> 0;
    this.pitchY = rowStep === 0 ? 16 : rowStep | 0;
    this.stackStep = stackStep === 0 ? 16 : stackStep | 0;
    this.halfWidth = this.pitchX >>> 1;
    this.baseline = baseline === 0 ? Math.imul(this.pitchY, 35) : baseline | 0;
    this.rowLayer = rowLayer | 0;
    this.stackLayer = stackLayer | 0;
  }
  override hasExpandedSortKeys(): number {
    this.check();
    return 1;
  }
  override move(x: number, y: number): void {
    this.setCoordinates(x << 16, y << 16, this.coordinates().z);
  }
  private releaseTerrain(): void {
    for (const chip of this.chips) chip.bitmap.storage?.release();
    for (const terrain of this.terrains) {
      terrain.bitmap.storage?.release();
      terrain.mask?.storage?.release();
    }
    this.chips = [];
    this.terrains = [];
    this.initialized = false;
  }
  private releaseRows(): void {
    this.rows = null;
    this.columns = 0;
    this.copiedCells = null;
    this.initialized = false;
  }
  override dispose(): void {
    this.check();
    this.releaseTerrain();
    this.releaseRows();
    for (const bitmap of this.overlays) bitmap.storage?.release();
    this.overlays = [];
    super.dispose();
  }
  private validLayer(layer: number, rows = this.rows?.length ?? 0): boolean {
    return (Math.imul((rows || 1) - 1, this.rowLayer) + layer) >>> 0 < 0x10000;
  }
  private cellKey(row: number, terrain: Terrain): number {
    const height = Math.imul((terrain.top - 1 + terrain.extraLayer) | 0, this.stackLayer);
    return (
      (Math.imul((Math.imul((height + Math.imul(this.rowLayer, row)) | 0, 0x800) + row) | 0, 0x20) +
        (this.sortKey() & 0xffffe01f)) >>>
      0
    );
  }
  override setLayer(layer: number): 0 | 1 {
    this.check();
    if (!this.validLayer(layer)) return 0;
    super.setLayer(layer);
    this.rows?.forEach((row, y) =>
      row.cells.forEach((cell) => {
        if (cell.terrain !== EMPTY && cell.key !== 0)
          cell.key = this.cellKey(y, this.terrain(cell.terrain));
      }),
    );
    this.refreshKeys();
    return 1;
  }
  configure(x: number, y: number, mode: number, level: number, layer: number): number {
    if (!this.setLayer(layer)) return 7;
    this.move(x, y);
    this.blendMode = mode | 0;
    this.setBlendValue(level);
    return 0;
  }
  private terrain(index: number): Terrain {
    const terrain = this.terrains[index >>> 0];
    if (terrain === undefined)
      throw new RangeError('Buriko Landscape terrain access outside owned array');
    return terrain;
  }
  private chip(index: number): Chip {
    const chip = this.chips[index >>> 0];
    if (chip === undefined)
      throw new RangeError('Buriko Landscape chip access outside owned array');
    return chip;
  }
  private copyRect(
    source: BurikoBitmap,
    words: LandscapeWords,
    index: number,
  ): BurikoBitmap | null {
    const at = index * 5,
      x = words(at) | 0,
      y = words(at + 1) | 0,
      width = words(at + 2) >>> 0,
      height = words(at + 3) >>> 0;
    const right = (x - 1 + width) | 0,
      bottom = (y - 1 + height) | 0;
    if (
      width === 0 ||
      height === 0 ||
      x < 0 ||
      y < 0 ||
      right >= source.width ||
      bottom >= source.height
    )
      return null;
    const bitmap = allocateBurikoBitmap(width, height, source.format);
    this.environment.compositor.draw(bitmap, -x, -y, source, 0x80, 0);
    return bitmap;
  }
  /** 05E530: 20-byte chip records and 136-byte terrain recipes are copied and composed. */
  loadTerrain(
    surface: number,
    chipCount: number,
    chipWords: LandscapeWords,
    topCover: number,
    terrainCount: number,
    terrainWords: LandscapeWords,
  ): number {
    this.check();
    chipCount >>>= 0;
    terrainCount >>>= 0;
    if (!chipCount) {
      this.value124 = EMPTY;
      return 2;
    }
    if (!terrainCount) {
      this.value124 = EMPTY;
      return 3;
    }
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 1;
    const chips: Chip[] = [],
      terrains: Terrain[] = [];
    const failed = (code: number, index: number): number => {
      this.value124 = index >>> 0;
      for (const chip of chips) chip.bitmap.storage?.release();
      for (const terrain of terrains) {
        terrain.bitmap.storage?.release();
        terrain.mask?.storage?.release();
      }
      return code;
    };
    for (let i = 0; i < chipCount; i++) {
      const bitmap = this.copyRect(source, chipWords, i);
      if (bitmap === null) return failed(2, i);
      chips.push({bitmap, pending: true, dependents: []});
    }
    for (let i = 0; i < terrainCount; i++) {
      const at = i * 34,
        count = terrainWords(at) >>> 0,
        top = terrainWords(at + 33) >>> 0;
      if ((count - 1) >>> 0 > 31 || (top - 1) >>> 0 > 31) return failed(3, i);
      const parts: number[] = [];
      let width = 0,
        height = 0;
      for (let j = 0; j < count; j++) {
        const index = terrainWords(at + 1 + j) >>> 0;
        parts.push(index);
        if (index < chipCount) {
          width = Math.max(width, chipWords(index * 5 + 2) >>> 0);
          height = Math.max(
            height,
            (Math.imul(this.stackStep, j) + chipWords(index * 5 + 3)) >>> 0,
          );
        } else if (index !== EMPTY) return failed(3, i);
      }
      const bitmap = allocateBurikoBitmap(width, height, source.format);
      clearBurikoBitmap(bitmap);
      let mask: BurikoBitmap | null = null,
        cover = 0,
        covering = true,
        extraLayer = 0;
      for (let j = 0; j < parts.length; j++) {
        const index = parts[j]!;
        if (index === EMPTY) {
          covering = false;
          continue;
        }
        const chip = chips[index]!.bitmap;
        this.environment.compositor.draw(
          bitmap,
          (width - chip.width) >> 1,
          (height - Math.imul(this.stackStep, j) - chip.height) | 0,
          chip,
          1,
          0,
        );
        if (covering) {
          if (chipWords(index * 5 + 4) === 0) {
            if (j + 1 === top) {
              cover = (cover + topCover) | 0;
              covering = false;
            } else cover = (cover + 1) | 0;
          } else covering = false;
        }
        if (j + 1 === top && j + 1 < count) {
          mask = allocateBurikoBitmap(width, height, 3);
          // 053730 only writes when the composed source is RGBA.
          if (bitmap.format === 2)
            for (let y = 0; y < height; y++)
              for (let x = 0; x < width; x++)
                bitmapWrite8(
                  mask,
                  mask.offset + y * mask.stride + x,
                  bitmapRead8(bitmap, bitmap.offset + y * bitmap.stride + x * 4 + 3),
                );
          extraLayer = Math.max(
            1,
            ((((height >>> 0) / (this.stackStep >>> 0)) >>> 0) - top - 2) | 0,
          );
        }
      }
      const offsetX = (this.pitchX - width) >> 1;
      terrains.push({
        parts,
        top,
        bitmap,
        mask,
        offsetX,
        cover: offsetX > 0 ? 0 : Math.imul(this.stackStep, cover),
        extraLayer,
      });
    }
    this.releaseTerrain();
    this.releaseRows();
    this.chips = chips;
    this.terrains = terrains;
    return 0;
  }
  /** 05DC20 installs independently owned overlay sprites. */
  loadOverlays(surface: number, count: number, words: LandscapeWords): number {
    this.check();
    count >>>= 0;
    if (!count) {
      this.value124 = EMPTY;
      return 2;
    }
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 1;
    const next: BurikoBitmap[] = [];
    for (let i = 0; i < count; i++) {
      const bitmap = this.copyRect(source, words, i);
      if (bitmap === null) {
        this.value124 = i;
        return 2;
      }
      next.push(bitmap);
    }
    for (const bitmap of this.overlays) bitmap.storage?.release();
    this.overlays = next;
    return 0;
  }
  private buildCell(
    rows: Row[],
    row: number,
    column: number,
    width: number,
    height: number,
    cells: LandscapeWords,
  ): void {
    row >>>= 0;
    column >>>= 0;
    if (row >= height || column >= width) return;
    const cell = rows[row]!.cells[column]!,
      index = cells(row * width + column) >>> 0;
    cell.terrain = index;
    if (index === EMPTY) return;
    const terrain = this.terrain(index),
      neighborX = row & 1 ? column : column - 1;
    const cover = (x: number, y: number): number => {
      if (x >>> 0 >= width || y >>> 0 >= height) return 0;
      const index = cells(y * width + x) >>> 0;
      return index === EMPTY ? 0 : this.terrain(index).cover;
    };
    const first = (cover(neighborX, row + 1) - this.pitchY) | 0;
    let covered = 0;
    if (first > 0) {
      const second = (cover(neighborX + 1, row + 1) - this.pitchY) | 0;
      if (second > 0) covered = Math.min(first, second);
    }
    const third = (cover(column, row + 2) - Math.imul(this.pitchY, 2)) | 0;
    if (third > 0) covered = Math.min(covered, third);
    const visible = (terrain.bitmap.height - covered) | 0;
    if (visible <= 0) {
      cell.key = 0;
      return;
    }
    const left =
      (Math.imul(this.pitchX, column) + terrain.offsetX + (row & 1 ? this.halfWidth : 0)) | 0;
    const top = (Math.imul(this.pitchY, row) + this.baseline - terrain.bitmap.height) | 0;
    cell.rectangle = {
      left,
      top,
      right: (left + terrain.bitmap.width - 1) | 0,
      bottom: (top + visible - 1) | 0,
    };
    cell.key = this.cellKey(row, terrain);
    cell.overlays.fill(EMPTY);
    cell.levels.fill(0);
    cell.colorMode = cell.colorLevel = cell.color = 0;
  }
  /** 05E2E0 copies terrain IDs into row-owned cell records. */
  replaceCells(width: number, height: number, words: LandscapeWords): number {
    this.check();
    width >>>= 0;
    height >>>= 0;
    if (!this.terrains.length) return 4;
    if (
      (width - 1) >>> 0 >= 256 ||
      (height - 1) >>> 0 >= 256 ||
      !this.validLayer(this.getLayer(), height)
    )
      return 5;
    for (let i = 0; i < width * height; i++) {
      const index = words(i) >>> 0;
      if (index >= this.terrains.length && index !== EMPTY) return 6;
    }
    const rows: Row[] = Array.from({length: height}, () => ({
      cells: Array.from({length: width}, blankCell),
      minimum: 0,
      maximum: 0,
    }));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) this.buildCell(rows, y, x, width, height, words);
    this.releaseRows();
    this.rows = rows;
    this.columns = width;
    this.refreshKeys();
    this.configureGeometry(
      (Math.imul(this.pitchX, width) + this.halfWidth) | 0,
      (Math.imul(this.pitchY, height - 1) + this.baseline) | 0,
    );
    this.initialized = true;
    return 0;
  }
  private refreshKeys(): void {
    this.replaceExpandedSortKeys(null);
    if (this.rows === null) return;
    const keys: number[] = [];
    for (const row of this.rows) {
      const unique = new Set<number>();
      row.minimum = EMPTY;
      row.maximum = 0;
      for (const cell of row.cells)
        if (cell.terrain !== EMPTY && cell.key !== 0) {
          unique.add(cell.key);
          row.minimum = Math.min(row.minimum, cell.key);
          row.maximum = Math.max(row.maximum, cell.key);
        }
      keys.push(...unique);
    }
    nativeQuickSort(
      keys.length,
      (a, b) => (keys[a]! - keys[b]!) | 0,
      (a, b) => {
        const value = keys[a]!;
        keys[a] = keys[b]!;
        keys[b] = value;
      },
    );
    this.replaceExpandedSortKeys(Uint32Array.from(keys));
  }
  private cellStatus(row: number, column: number): number {
    if (this.rows === null) return 13;
    if (row >>> 0 >= this.rows.length) return 11;
    if (column >>> 0 >= this.columns) return 12;
    return 0;
  }
  private invalidateCell(row: number, column: number): void {
    if (this.cellStatus(row, column)) return;
    const cell = this.rows![row]!.cells[column]!,
      rectangle = {...cell.rectangle},
      position = this.effectivePosition();
    translateBurikoBitmapRectangle(rectangle, position.x, position.y);
    this.environment.damage.record(cell.key, rectangle);
  }
  setColor(row: number, column: number, mode: number, level: number, color: number): number {
    const status = this.cellStatus(row, column);
    if (status) return status;
    if (mode >>> 0 >= 3) return 18;
    if (level >>> 0 > 256) return 19;
    const cell = this.rows![row]!.cells[column]!;
    cell.colorMode = mode >>> 0;
    cell.colorLevel = level >>> 0;
    cell.color = color >>> 0;
    this.invalidateCell(row, column);
    return 0;
  }
  setOverlay(row: number, column: number, channel: number, index: number, level: number): number {
    const status = this.cellStatus(row, column);
    if (status) return status;
    if (channel >>> 0 > 3) return 16;
    index >>>= 0;
    if (index >= this.overlays.length && index !== EMPTY) return 17;
    const cell = this.rows![row]!.cells[column]!;
    cell.overlays[channel] = index;
    cell.levels[channel] = level >>> 0;
    this.invalidateCell(row, column);
    return 0;
  }
  replaceCell(row: number, column: number, index: number): number {
    const status = this.cellStatus(row, column);
    if (status) return status;
    index >>>= 0;
    if (index >= this.terrains.length && index !== EMPTY) return 10;
    const rows = this.rows!;
    if (this.copiedCells === null)
      this.copiedCells = Uint32Array.from(
        rows.flatMap((row) => row.cells.map((cell) => cell.terrain)),
      );
    this.copiedCells[row * this.columns + column] = index;
    const words = (i: number): number => this.copiedCells![i]!;
    const neighborX = row & 1 ? column : column - 1;
    this.invalidateCell(row, column);
    for (const [y, x] of [
      [row, column],
      [row - 1, neighborX],
      [row - 1, neighborX + 1],
      [row - 2, column],
    ]) {
      this.buildCell(rows, y!, x!, this.columns, rows.length, words);
      this.invalidateCell(y!, x!);
    }
    this.refreshKeys();
    return 0;
  }
  replaceChip(destination: number, source: number): number {
    destination >>>= 0;
    source >>>= 0;
    if (!this.terrains.length) return 4;
    if (destination >= this.chips.length) return 8;
    if (source >= this.chips.length) return 9;
    const target = this.chip(destination),
      input = this.chip(source).bitmap;
    if (
      target.bitmap.width !== input.width ||
      target.bitmap.height !== input.height ||
      target.bitmap.format !== input.format
    )
      return 9;
    copyBurikoBitmapRows(target.bitmap, input);
    if (target.pending) {
      target.dependents = this.terrains.flatMap((terrain, i) =>
        terrain.parts.includes(destination) ? [i] : [],
      );
      target.pending = false;
    }
    for (const index of target.dependents) {
      const terrain = this.terrain(index);
      clearBurikoBitmap(terrain.bitmap);
      for (let j = 0; j < terrain.parts.length; j++) {
        const chip = this.chip(terrain.parts[j]!).bitmap;
        this.environment.compositor.draw(
          terrain.bitmap,
          (terrain.bitmap.width - chip.width) >> 1,
          (terrain.bitmap.height - Math.imul(this.stackStep, j) - chip.height) | 0,
          chip,
          1,
          0,
        );
      }
    }
    if (this.initialized && target.dependents.length)
      this.rows?.forEach((row, y) =>
        row.cells.forEach((cell, x) => {
          if (target.dependents.includes(cell.terrain)) this.invalidateCell(y, x);
        }),
      );
    return 0;
  }
  readCellLayer(row: number, column: number, write: (value: number) => void): number {
    const status = this.cellStatus(row, column);
    if (status) return status;
    const cell = this.rows![row]!.cells[column]!;
    if (cell.terrain === EMPTY) return 14;
    write(cell.key >>> 16);
    return 0;
  }
  copyCellTop(surface: number, row: number, column: number): number {
    const status = this.cellStatus(row, column);
    if (status) return status;
    const cell = this.rows![row]!.cells[column]!;
    if (cell.terrain === EMPTY) return 14;
    const terrain = this.terrain(cell.terrain),
      source = this.chip(terrain.parts[terrain.top - 1]!).bitmap;
    if (!this.surfaces.allocate(surface, source.width, source.height, source.format)) return 15;
    copyBurikoBitmapRows(this.surfaces.snapshot(surface)!, source);
    return 0;
  }
  hitCell(x: number, y: number, mode: number, write: (x: number, y: number) => void): number {
    if (!this.initialized) return 13;
    x |= 0;
    y |= 0;
    const column = Math.trunc(x / (this.pitchX | 0));
    const start =
      (Math.trunc(((y - this.baseline) | 0) / this.pitchY) + (this.baseline <= y ? 1 : 0)) | 0;
    const lower = Math.max(0, start),
      upper = Math.min(
        this.rows!.length - 1,
        (start + ((((this.stackStep << 5) >>> 0) / (this.pitchY >>> 0)) >>> 0)) | 0,
      );
    for (let row = upper; row >= lower; row--) {
      const col = column - ((row & 1) !== 0 && (x >>> 0) % this.pitchX < this.halfWidth ? 1 : 0);
      if (col < 0 || col >= this.columns) continue;
      const cell = this.rows![row]!.cells[col]!,
        r = cell.rectangle;
      if (cell.terrain === EMPTY || x < r.left || x > r.right || y < r.top || y > r.bottom)
        continue;
      const terrain = this.terrain(cell.terrain),
        bitmap = mode === 1 && terrain.mask !== null ? terrain.mask : terrain.bitmap;
      if (bitmap.format !== 2 && bitmap.format !== 3) continue;
      const offset =
        bitmap.offset +
        Math.imul(y - r.top, bitmap.stride) +
        Math.imul(x - r.left, bitmap.bytesPerPixel) +
        (bitmap.format === 2 ? 3 : 0);
      if (bitmapRead8(bitmap, offset) !== 0) {
        write(col, row);
        return 0;
      }
    }
    return 14;
  }
  /** 05D1F0 renders each expanded sort key through the shared compositor/worker. */
  override draw(destination: BurikoBitmap, rectangle: BurikoBitmapRectangle, key: number): void {
    this.check();
    if (!this.initialized) return;
    const level = this.effectiveBlendValue();
    const clipped = (
      source: BurikoBitmap,
      bounds: BurikoBitmapRectangle,
    ): {destination: BurikoBitmap; source: BurikoBitmap} | null => {
      const area = {...bounds};
      if (!intersectBurikoBitmapRectangle(area, rectangle)) return null;
      const output = {...destination},
        input = {...source};
      cropBurikoBitmap(output, {
        left: area.left - rectangle.left,
        top: area.top - rectangle.top,
        right: area.right - rectangle.left,
        bottom: area.bottom - rectangle.top,
      });
      translateBurikoBitmapRectangle(area, -bounds.left, -bounds.top);
      cropBurikoBitmap(input, area);
      return {destination: output, source: input};
    };
    for (const row of this.rows!) {
      if (key >>> 0 < row.minimum || key >>> 0 > row.maximum) continue;
      for (const cell of row.cells) {
        if (cell.key !== key >>> 0 || cell.terrain === EMPTY) continue;
        const terrain = this.terrain(cell.terrain),
          pair = clipped(terrain.bitmap, cell.rectangle);
        if (pair === null) continue;
        if (cell.colorMode === 0)
          this.environment.compositor.composite(
            pair.destination,
            pair.source,
            this.blendMode,
            level,
            true,
          );
        else {
          const tint = allocateBurikoBitmap(
              pair.source.width,
              pair.source.height,
              pair.source.format,
            ),
            mixed = allocateBurikoBitmap(pair.source.width, pair.source.height, pair.source.format);
          if (pair.source.format === 2)
            for (let y = 0; y < pair.source.height; y++)
              for (let x = 0; x < pair.source.width; x++)
                bitmapWrite32(
                  tint,
                  tint.offset + y * tint.stride + x * 4,
                  (bitmapRead32(pair.source, pair.source.offset + y * pair.source.stride + x * 4) &
                    0xff000000) |
                    (cell.color & 0xffffff),
                );
          copyBurikoBitmapRows(mixed, pair.source);
          this.environment.compositor.composite(
            mixed,
            tint,
            cell.colorMode === 2 ? 0x21 : 0x20,
            256 - cell.colorLevel,
            true,
          );
          this.environment.compositor.composite(
            pair.destination,
            mixed,
            this.blendMode,
            level,
            true,
          );
          tint.storage?.release();
          mixed.storage?.release();
        }
        for (let i = 0; i < 4; i++) {
          const index = cell.overlays[i]!;
          if (index === EMPTY) continue;
          const overlay = this.overlays[index];
          if (overlay === undefined)
            throw new RangeError('Buriko Landscape overlay access outside owned array');
          const left = (((terrain.bitmap.width - overlay.width) >> 1) + cell.rectangle.left) | 0,
            top =
              (terrain.bitmap.height -
                Math.imul(this.stackStep, terrain.top) -
                overlay.height +
                cell.rectangle.top) |
              0;
          const pair = clipped(overlay, {
            left,
            top,
            right: (left + overlay.width - 1) | 0,
            bottom: (top + overlay.height - 1) | 0,
          });
          if (pair !== null)
            this.environment.compositor.composite(
              pair.destination,
              pair.source,
              this.blendMode,
              (256 - (Math.imul(256 - cell.levels[i]!, 256 - level) >>> 8)) >>> 0,
              true,
            );
        }
      }
    }
  }
}
