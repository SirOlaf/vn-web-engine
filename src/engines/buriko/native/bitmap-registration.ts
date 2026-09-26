import {textBytes} from './text.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoCodecPointer} from './codec-storage.js';
import {burikoPackedBitmapFormat, importBurikoPackedBitmap} from './bitmap-image.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoSurfaces} from './surfaces.js';

/** 0374A0/0376E0 register in the same owners later read by BitmapLoading. */
export class BurikoBitmapRegistration {
  constructor(
    readonly loading: BurikoResourceLoadingState,
    readonly surfaces: BurikoSurfaces,
  ) {}

  cache(
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer | null,
    source: BurikoCodecPointer | null,
    count: number,
  ): number {
    return this.loading.cache.insertPointer(archive, name, source, count) === 0 ? 0xffffffff : 0;
  }

  import(index: number, source: BurikoCodecPointer): 0 | 1 | 2 {
    return importBurikoPackedBitmap(
      this.surfaces,
      index,
      source.bytes.subarray(source.offset),
      source.initialized?.subarray(source.offset),
    );
  }

  /** Raw 90:C6 captures names only after the source header format gate. */
  preloadPointers(
    archive: BurikoBpPointer | null,
    name: BurikoBpPointer | null,
    source: BurikoCodecPointer | null,
    count: number,
  ): 0 | 1 {
    if (source === null) throw new Error('Buriko preload reads a null bitmap header');
    if (
      burikoPackedBitmapFormat(
        source.bytes.subarray(source.offset),
        source.initialized?.subarray(source.offset),
      ) === -1
    )
      return 1;
    const archiveBytes = archive === null ? null : textBytes(archive).slice();
    if (name === null) throw new Error('Buriko preload consumes a null name');
    this.loading.preloaded.insertPointer(archiveBytes, textBytes(name).slice(), source, count);
    return 0;
  }

  preload(
    archive: Uint8Array | null,
    name: Uint8Array,
    source: BurikoCodecPointer,
    count: number,
  ): 0 | 1 {
    if (
      burikoPackedBitmapFormat(
        source.bytes.subarray(source.offset),
        source.initialized?.subarray(source.offset),
      ) === -1
    )
      return 1;
    this.loading.preloaded.insertPointer(archive, name, source, count);
    return 0;
  }
}
