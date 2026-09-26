import {BurikoBitmapStorage} from './bitmap.js';

/** CMemoryDX (06e0f0): a single aligned allocation, independent of bitmap descriptors. */
export class BurikoMemoryDx {
  private allocated = 0;
  private storage: BurikoBitmapStorage | null = null;
  private length = 0;
  private disposed = false;

  private check(): void {
    if (this.disposed) throw new Error('Buriko accesses a deleted CMemoryDX');
  }
  get active(): number {
    this.check();
    return this.allocated;
  }
  get size(): number {
    this.check();
    return this.length;
  }
  get allocation(): BurikoBitmapStorage | null {
    this.check();
    return this.storage;
  }

  /** 06e0a0 marks the owner allocated even when the platform allocation returns null. */
  allocate(size: number): BurikoBitmapStorage | null {
    this.check();
    if (this.allocated !== 0) return null;
    size >>>= 0;
    let storage: BurikoBitmapStorage | null;
    try {
      storage = new BurikoBitmapStorage(new Uint8Array(size), false);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      storage = null;
    }
    this.storage = storage;
    this.length = size;
    this.allocated = 1;
    return storage;
  }

  /** 06e060 returns the previous allocation flag, and clears fields only when it was nonzero. */
  free(): number {
    this.check();
    const previous = this.allocated;
    if (previous !== 0) {
      this.storage?.release();
      this.storage = null;
      this.length = 0;
      this.allocated = 0;
    }
    return previous;
  }
  dispose(): void {
    this.check();
    this.free();
    this.disposed = true;
  }
}
