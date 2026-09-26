import {cropAokanaBitmap, type AokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {bitmapRead16, bitmapRead32} from './bitmap-scalar.js';
import {AokanaBackdrop} from './display-backdrop.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaSurfaces} from './surfaces.js';

interface DifferenceSource {
  index: number;
  imageId: number;
  tables: (AokanaBitmapRectangle[] | null)[];
}

/** CDspObjBackD:057CE0, ordered pair difference tables057A40/0576C0. */
export class AokanaDifferenceBackdrop extends AokanaBackdrop {
  private sources: DifferenceSource[] = Array.from({length: 32}, () => ({
    index: -1,
    imageId: 0,
    tables: new Array<AokanaBitmapRectangle[] | null>(32).fill(null),
  }));
  private count: number | undefined;
  private previous: number | undefined;
  constructor(
    environment: AokanaDisplayObjectEnvironment,
    readonly surfaces: AokanaSurfaces,
  ) {
    super(environment, 5);
  }
  /** 057600 clears all32 entries and all32 owned tables in each entry. */
  private clearSources(): void {
    for (const source of this.sources) {
      source.index = -1;
      source.imageId = 0;
      source.tables.fill(null);
    }
    this.count = 0;
    this.previous = 0xffffffff;
  }
  override setActivation(value: number): void {
    this.previous = 0xffffffff;
    super.setActivation(value);
  }
  override setContentEnabled(value: number): void {
    this.previous = 0xffffffff;
    super.setContentEnabled(value);
  }
  override resizeToDisplay(): 0 | 1 {
    this.check();
    this.clearSources();
    return super.resizeToDisplay();
  }
  override notify(...args: unknown[]): void {
    this.check();
    if (typeof args[0] === 'number' && args[0] >>> 0 === 0xf0000000)
      this.previous = this.getBlendValue() >>> 0;
  }
  /** Native setup clears first, publishes count, then allocates/builds every ordered pair. */
  setSurfaces(count: number, indices: readonly number[]): 0 | 0x80000001 | 0x80000002 {
    this.check();
    this.clearSources();
    count >>>= 0;
    if ((count - 2) >>> 0 > 30) return 0x80000001;
    for (let index = 0; index < count; index++) {
      const surface = indices[index];
      if (surface === undefined)
        throw new Error('Aokana difference backdrop reads unwritten source array');
      if (this.acceptsSurface(this.surfaces, surface) === 0) {
        this.clearSources();
        return 0x80000002;
      }
      this.sources[index]!.index = surface | 0;
      this.sources[index]!.imageId = this.surfaces.imageId(surface);
    }
    this.count = count;
    for (let current = 0; current < count; current++) {
      const entry = this.sources[current]!;
      for (let previous = 0; previous < count; previous++) {
        const rectangles: AokanaBitmapRectangle[] = [];
        entry.tables[previous] = rectangles;
        this.buildDifferences(rectangles, this.sources[previous]!.index, entry.index);
      }
    }
    return 0;
  }
  /** 0576C0 compares32x24 cells, coalescing only adjacent changed cells on a row. */
  private buildDifferences(
    rectangles: AokanaBitmapRectangle[],
    firstIndex: number,
    secondIndex: number,
  ): number {
    const display = this.environment.displayBitmap(),
      first = this.surfaces.snapshot(firstIndex);
    if (first === null) return 0x80000003;
    if (this.acceptsBitmap(first) === 0) return 0x80000004;
    const second = this.surfaces.snapshot(secondIndex);
    if (second === null) return 0x80000005;
    if (this.acceptsBitmap(second) === 0) return 0x80000006;
    const width = display.width >>> 5,
      height = Math.trunc((display.height >>> 0) / 24);
    rectangles.length = 0;
    for (let cellY = 0; cellY < 24; cellY++) {
      let run: AokanaBitmapRectangle | null = null;
      for (let cellX = 0; cellX < 32; cellX++) {
        const rowStart = (bitmap: AokanaBitmap): number =>
          bitmap.offset +
          (Math.imul(Math.imul(bitmap.bytesPerPixel, cellX), width) >>> 0) +
          Math.imul(Math.imul(bitmap.stride, cellY), height);
        let a = rowStart(first),
          b = rowStart(second),
          changed = false;
        for (let y = 0; y < height && !changed; y++) {
          for (let x = 0; x < width && !changed; x++) {
            const ap = a + x * (first.bytesPerPixel >>> 0),
              bp = b + x * (second.bytesPerPixel >>> 0);
            if (display.format === 0)
              changed = bitmapRead16(first, ap) !== bitmapRead16(second, bp);
            else if (display.format === 1)
              changed = ((bitmapRead32(first, ap) ^ bitmapRead32(second, bp)) & 0xffffff) !== 0;
          }
          a += first.stride | 0;
          b += second.stride | 0;
        }
        if (!changed) {
          run = null;
          continue;
        }
        if (run !== null) run.right = (run.right + width) | 0;
        else {
          if (rectangles.length >= 384)
            throw new RangeError('Aokana difference table exceeds native rectangle allocation');
          run = {
            left: Math.imul(cellX, width),
            top: Math.imul(cellY, height),
            right: (Math.imul(cellX + 1, width) - 1) | 0,
            bottom: (Math.imul(cellY + 1, height) - 1) | 0,
          };
          rectangles.push(run);
        }
      }
    }
    return 0;
  }
  override invalidate(): void {
    this.check();
    const current = this.getBlendValue() >>> 0;
    if (current >= 32) return;
    if (this.count === undefined || this.previous === undefined)
      throw new Error('Aokana difference backdrop invalidates before source configuration');
    if (this.previous >= this.count) {
      super.invalidate();
      return;
    }
    const rectangles = this.sources[current]!.tables[this.previous];
    // The unconfigured native record has count zero and a null pointer.
    if (rectangles == null) return;
    for (const rectangle of rectangles) this.environment.damage.record(this.sortKey(), rectangle);
  }
  override drawContent(destination: AokanaBitmap, rectangle: AokanaBitmapRectangle): 0 | 1 {
    this.check();
    if (this.count === undefined)
      throw new Error('Aokana difference backdrop draws before source configuration');
    const current = this.getBlendValue() >>> 0;
    if (current >= this.count) return 0;
    const entry = this.sources[current]!,
      source = this.surfaces.snapshot(entry.index);
    if (source === null || this.surfaces.imageId(entry.index) !== entry.imageId) return 0;
    cropAokanaBitmap(source, rectangle);
    this.environment.compositor.composite(destination, source, 0x80, 0, true);
    return 1;
  }
  override dispose(): void {
    this.check();
    this.clearSources();
    super.dispose();
  }
}
