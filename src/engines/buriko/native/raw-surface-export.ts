import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoBitmapStorage} from './bitmap.js';
import {bitmapRead8, bitmapRead16, bitmapRead32} from './bitmap-scalar.js';

/** 036A50/042100 export packed pixels through the actual small CRT memmove paths. */
export class BurikoRawSurfaceExport {
  constructor(readonly surfaces: BurikoSurfaces) {}

  export(
    output: BurikoBpPointer | null,
    count: BurikoBpPointer | null,
    capacity: number,
    index: number,
  ): 0 | 9 | 10 {
    const bitmap = this.surfaces.snapshot(index);
    if (bitmap === null) return 9;
    const bits = [16, 24, 32, 8][bitmap.format >>> 0];
    if (bits === undefined)
      throw new Error('Buriko raw export reads outside its initialized local format table');
    const packed = bits >>> 3,
      size = Math.imul(Math.imul(bitmap.width, bitmap.height), packed) >>> 0;
    if (capacity >>> 0 < size) return 10;
    let sourceRow = bitmap.offset,
      outputOffset = 0;
    const store = (relative: number, length: 1 | 2 | 4, value: number): void => {
      this.store(output, relative, length, value, bitmap.storage);
    };
    for (let y = 0; y < bitmap.height >>> 0; y++) {
      let source = sourceRow;
      for (let x = 0; x < bitmap.width >>> 0; x++) {
        if (packed === 1) store(outputOffset, 1, bitmapRead8(bitmap, source));
        else if (packed === 2) store(outputOffset, 2, bitmapRead16(bitmap, source));
        else if (packed === 3) {
          // 1367F snapshots both source reads before its word and byte stores.
          const low = bitmapRead16(bitmap, source),
            high = bitmapRead8(bitmap, source + 2);
          store(outputOffset, 2, low);
          store(outputOffset + 2, 1, high);
        } else store(outputOffset, 4, bitmapRead32(bitmap, source));
        source += bitmap.bytesPerPixel >>> 0;
        outputOffset += packed;
      }
      sourceRow += bitmap.stride | 0;
    }
    this.store(count, 0, 4, size, bitmap.storage);
    return 0;
  }

  private store(
    pointer: BurikoBpPointer | null,
    relative: number,
    length: 1 | 2 | 4,
    value: number,
    backing: BurikoBitmapStorage | null,
  ): void {
    if (pointer === null) throw new Error('Buriko raw export writes through a null pointer');
    const offset = pointer.offset + relative,
      view = pointerView({bytes: pointer.bytes, offset}, length);
    if (length === 1) view.setUint8(0, value);
    else if (length === 2) view.setUint16(0, value, true);
    else view.setUint32(0, value, true);
    if (backing !== null && backing.bytes.buffer === pointer.bytes.buffer) {
      const start = pointer.bytes.byteOffset + offset - backing.bytes.byteOffset,
        first = Math.max(0, start),
        last = Math.min(backing.bytes.length, start + length);
      if (first < last) backing.written(first, last - first);
    }
  }
}
