import {BurikoSurfaces} from './surfaces.js';
import {BurikoResourceLoadingState} from './resource-loading.js';
import {BurikoBitmapLoadState} from './bitmap-load-state.js';
import {importBurikoPackedBitmap, importBurikoWindowsBitmap} from './bitmap-image.js';

/** Shared cached/synchronous bitmap paths beneath 90 10, using the same table and two native caches. */
export class BurikoBitmapLoading {
  constructor(
    readonly surfaces: BurikoSurfaces,
    readonly resources: BurikoResourceLoadingState,
    readonly policy: BurikoBitmapLoadState,
  ) {}

  /** 0375F0 consumes the preload entry before decoding and promotes it only on success. */
  fromCache(index: number, archive: Uint8Array | null, name: Uint8Array, consume = 1): number {
    let bytes = this.resources.preloaded.read(archive, name, consume);
    if (bytes === null) {
      bytes = this.resources.cache.read(archive, name);
      consume = 0;
    }
    if (bytes === null) return 0xffffffff;
    const result = importBurikoPackedBitmap(this.surfaces, index, bytes);
    if (result === 1) return 0x80000004;
    if (result === 2) return 0x80000008;
    if (consume !== 0) this.resources.cache.insert(archive, name, bytes);
    return 0;
  }

  /** 0374D0 / BDC30 use non-retrying resource lookup for the synchronous skip path. */
  async synchronous(index: number, archive: Uint8Array | null, name: Uint8Array): Promise<number> {
    const operationAllocator = this.surfaces.allocator,
      operationActor = operationAllocator.currentActor;
    const runAsActor = <T>(operation: () => T): T =>
      operationAllocator.withActor(operationActor, operation);

    let bytes = this.resources.cache.read(archive, name);
    if (bytes === null) {
      const loaded = await runAsActor(() => this.resources.resources.load(archive, name, false));
      if (loaded.result === 0) return 0x80000019;
      bytes = loaded.bytes;
      if (bytes === null)
        throw new Error('Buriko synchronous bitmap load has no successful resource bytes');
      this.resources.cache.insert(archive, name, bytes.subarray(0, loaded.result >>> 0));
    }
    const bitmap = runAsActor(() => importBurikoWindowsBitmap(this.surfaces, index, bytes));
    if (bitmap !== 0x80000001) return bitmap;
    const result = runAsActor(() => importBurikoPackedBitmap(this.surfaces, index, bytes));
    return result === 1 ? 0x80000004 : result === 2 ? 0x80000008 : 0;
  }
}
