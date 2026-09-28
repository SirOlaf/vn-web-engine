import {copyMemoryBytes} from '../../../core/indeterminate-memory.js';

/**
 * One contiguous VM storage allocation: the global arena, a thread's module, frame or heap
 * bank, a pooled allocation, or an indirect buffer/string handle.
 *
 * A region never changes size. Native relocations (heap growth, `resizeGlobal`, indirect
 * buffer resizes, frees) allocate a successor and retire the current region. A retired
 * region keeps its final bytes, so a pointer obtained before the relocation still observes
 * the storage native code would read through a stale pointer.
 */
export class BurikoBpRegion {
  private bytes: Uint8Array;
  private isRetired = false;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /**
   * The region's bytes. A view obtained inside one synchronous handler stays valid until that
   * handler returns or allocates VM storage; state kept across calls or awaits holds the region.
   */
  view(): Uint8Array {
    return this.bytes;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  /** True once the owning bank has relocated or freed this allocation. */
  get retired(): boolean {
    return this.isRetired;
  }

  /** Owner-only: the successor, if any, is already installed. */
  retire(): void {
    this.isRetired = true;
  }
}

/** A native byte pointer. Bytes are resolved through the region only at use. */
export class BurikoBpPointer {
  constructor(
    readonly region: BurikoBpRegion,
    readonly offset: number,
  ) {}

  /** The whole region; `offset` indexes into it. */
  view(): Uint8Array {
    return this.region.view();
  }

  /** Native pointer arithmetic: the result addresses the same allocation. */
  add(displacement: number): BurikoBpPointer {
    return new BurikoBpPointer(this.region, this.offset + displacement);
  }
}

/** A pointer into host-owned bytes (decoder output, file data, native constants), outside VM banks. */
export function hostPointer(bytes: Uint8Array, offset = 0): BurikoBpPointer {
  return new BurikoBpPointer(new BurikoBpRegion(bytes), offset);
}

/**
 * The VM storage allocator. Every bank region is created, relocated and retired here, so the
 * table can later place regions in a shared backing arena without changing native callers.
 */
export class BurikoBpRegionTable {
  private readonly live = new Set<BurikoBpRegion>();

  /** A zero-filled region. */
  allocate(size: number): BurikoBpRegion {
    return this.adopt(new Uint8Array(size));
  }

  /** Registers bytes the caller has already filled as a live region. */
  adopt(bytes: Uint8Array): BurikoBpRegion {
    const region = new BurikoBpRegion(bytes);
    this.live.add(region);
    return region;
  }

  /** Native realloc: a zero-filled successor receives the first `preserved` bytes, provenance included. */
  relocate(
    region: BurikoBpRegion,
    size: number,
    preserved = Math.min(size, region.size),
  ): BurikoBpRegion {
    const successor = this.allocate(size);
    if (preserved > 0) copyMemoryBytes(successor.view(), 0, region.view(), 0, preserved);
    this.release(region);
    return successor;
  }

  release(region: BurikoBpRegion): void {
    if (this.live.delete(region)) region.retire();
  }

  get liveRegions(): number {
    return this.live.size;
  }

  /** Total bytes of live regions, for arena sizing. */
  get liveBytes(): number {
    let total = 0;
    for (const region of this.live) total += region.size;
    return total;
  }
}
