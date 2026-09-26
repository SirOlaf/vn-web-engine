import {textBytes} from './text.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaCodecPointer} from './codec-storage.js';
import {aokanaPackedBitmapFormat, importAokanaPackedBitmap} from './bitmap-image.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaSurfaces} from './surfaces.js';

/** 0374A0/0376E0 register in the same owners later read by BitmapLoading. */
export class AokanaBitmapRegistration {
  constructor(
    readonly loading: AokanaResourceLoadingState,
    readonly surfaces: AokanaSurfaces,
  ) {}

  cache(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer | null,
    source: AokanaCodecPointer | null,
    count: number,
  ): number {
    return this.loading.cache.insertPointer(archive, name, source, count) === 0 ? 0xffffffff : 0;
  }

  import(index: number, source: AokanaCodecPointer): 0 | 1 | 2 {
    return importAokanaPackedBitmap(
      this.surfaces,
      index,
      source.bytes.subarray(source.offset),
      source.initialized?.subarray(source.offset),
    );
  }

  /** Raw 90:C6 captures names only after the source header format gate. */
  preloadPointers(
    archive: AokanaBpPointer | null,
    name: AokanaBpPointer | null,
    source: AokanaCodecPointer | null,
    count: number,
  ): 0 | 1 {
    if (source === null) throw new Error('Aokana preload reads a null bitmap header');
    if (
      aokanaPackedBitmapFormat(
        source.bytes.subarray(source.offset),
        source.initialized?.subarray(source.offset),
      ) === -1
    )
      return 1;
    const archiveBytes = archive === null ? null : textBytes(archive).slice();
    if (name === null) throw new Error('Aokana preload consumes a null name');
    this.loading.preloaded.insertPointer(archiveBytes, textBytes(name).slice(), source, count);
    return 0;
  }

  preload(
    archive: Uint8Array | null,
    name: Uint8Array,
    source: AokanaCodecPointer,
    count: number,
  ): 0 | 1 {
    if (
      aokanaPackedBitmapFormat(
        source.bytes.subarray(source.offset),
        source.initialized?.subarray(source.offset),
      ) === -1
    )
      return 1;
    this.loading.preloaded.insertPointer(archive, name, source, count);
    return 0;
  }
}
