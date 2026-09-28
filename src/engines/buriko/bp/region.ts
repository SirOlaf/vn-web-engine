import {
  clearIndeterminateMemory,
  copyMemoryBytes,
  transferIndeterminateMemory,
} from '../../../core/indeterminate-memory.js';

/** Region bases are aligned for 32/64-bit typed views and wasm loads. */
const ALIGNMENT = 16;

interface FreeBlock {
  offset: number;
  size: number;
}

/** `ArrayBuffer.prototype.transfer` (ES2024) reallocates in place where possible and detaches the source. */
type TransferableBuffer = ArrayBuffer & {transfer?: (length: number) => ArrayBuffer};

/**
 * One growable `ArrayBuffer` holding every live region of a region table. Regions are placed
 * first fit at 16-byte aligned offsets. Growth reallocates the buffer, detaching the previous
 * one where the platform supports it, and advances `generation`; region views re-derive
 * themselves on their next use.
 */
export class BurikoBpArena {
  buffer: ArrayBuffer;
  generation = 0;
  private readonly free: FreeBlock[];
  private wholeBytes: Uint8Array;
  private wholeWords: Uint32Array;
  private viewsGeneration = 0;

  constructor(initialBytes: number) {
    const capacity = Math.max(ALIGNMENT, roundUp(initialBytes));
    this.buffer = new ArrayBuffer(capacity);
    this.free = [{offset: 0, size: capacity}];
    this.wholeBytes = new Uint8Array(this.buffer);
    this.wholeWords = new Uint32Array(this.buffer);
  }

  get capacity(): number {
    return this.buffer.byteLength;
  }

  /** Whole-arena views for the current generation. Invalid after any VM allocation. */
  views(): {readonly bytes: Uint8Array; readonly words: Uint32Array; readonly generation: number} {
    if (this.viewsGeneration !== this.generation) {
      this.wholeBytes = new Uint8Array(this.buffer);
      this.wholeWords = new Uint32Array(this.buffer);
      this.viewsGeneration = this.generation;
    }
    return {bytes: this.wholeBytes, words: this.wholeWords, generation: this.generation};
  }

  /** Returns the base of a zero-filled, provenance-free range of `size` bytes. */
  allocate(size: number): number {
    const reserved = roundUp(size);
    if (reserved === 0) return 0;
    let index = this.free.findIndex((block) => block.size >= reserved);
    if (index < 0) index = this.grow(reserved);
    const block = this.free[index]!;
    const base = block.offset;
    if (block.size === reserved) this.free.splice(index, 1);
    else {
      block.offset += reserved;
      block.size -= reserved;
    }
    const bytes = this.views().bytes;
    bytes.fill(0, base, base + size);
    clearIndeterminateMemory(bytes, base, size);
    return base;
  }

  release(base: number, size: number): void {
    const reserved = roundUp(size);
    if (reserved === 0) return;
    clearIndeterminateMemory(this.views().bytes, base, size);
    let index = this.free.findIndex((block) => block.offset > base);
    if (index < 0) index = this.free.length;
    this.free.splice(index, 0, {offset: base, size: reserved});
    const next = this.free[index + 1];
    if (next && base + reserved === next.offset) {
      this.free[index]!.size += next.size;
      this.free.splice(index + 1, 1);
    }
    const previous = this.free[index - 1];
    if (previous && previous.offset + previous.size === base) {
      previous.size += this.free[index]!.size;
      this.free.splice(index, 1);
    }
  }

  /** Doubles capacity until `reserved` bytes fit at the end; returns the free block there. */
  private grow(reserved: number): number {
    const previous = this.buffer,
      oldCapacity = previous.byteLength;
    const last = this.free.at(-1);
    const tail = last && last.offset + last.size === oldCapacity ? last.size : 0;
    let capacity = oldCapacity * 2;
    while (capacity - oldCapacity + tail < reserved) capacity *= 2;
    const transfer = (previous as TransferableBuffer).transfer;
    let next: ArrayBuffer;
    if (typeof transfer === 'function') next = transfer.call(previous, capacity);
    else {
      next = new ArrayBuffer(capacity);
      new Uint8Array(next).set(new Uint8Array(previous));
    }
    transferIndeterminateMemory(previous, next);
    this.buffer = next;
    this.generation++;
    if (tail !== 0) last!.size += capacity - oldCapacity;
    else this.free.push({offset: oldCapacity, size: capacity - oldCapacity});
    return this.free.length - 1;
  }
}

function roundUp(size: number): number {
  return Math.ceil(size / ALIGNMENT) * ALIGNMENT;
}

/**
 * One contiguous VM storage allocation: the global arena, a thread's operand stack, module,
 * frame or heap bank, a pooled allocation, or an indirect buffer/string handle. Host regions
 * wrap bytes that are not VM storage.
 *
 * A region never changes size. Native relocations (heap growth, `resizeGlobal`, indirect
 * buffer resizes, frees) allocate a successor and retire the current region. Retiring an
 * arena region copies its final bytes out of the arena, so a pointer obtained before the
 * relocation still observes the storage native code would read through a stale pointer.
 */
export class BurikoBpRegion {
  private bytes: Uint8Array;
  private words: Uint32Array | null = null;
  private wordsSource: Uint8Array | null = null;
  private arena: BurikoBpArena | null = null;
  private base = 0;
  private readonly length: number;
  private generation = 0;
  private isRetired = false;

  /** A host region over `bytes`. */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.length = bytes.length;
  }

  /** @internal A region at `base` in `arena`; created by `BurikoBpRegionTable`. */
  static inArena(arena: BurikoBpArena, base: number, size: number): BurikoBpRegion {
    const region = new BurikoBpRegion(new Uint8Array(arena.buffer, base, size));
    region.arena = arena;
    region.base = base;
    region.generation = arena.generation;
    return region;
  }

  /**
   * The region's bytes. A view obtained inside one synchronous handler stays valid until that
   * handler returns or allocates VM storage; state kept across calls or awaits holds the region.
   */
  view(): Uint8Array {
    const arena = this.arena;
    if (arena !== null && this.generation !== arena.generation) {
      this.bytes = new Uint8Array(arena.buffer, this.base, this.length);
      this.generation = arena.generation;
    }
    return this.bytes;
  }

  /** The region as little-endian 32-bit cells; same validity as `view`. */
  view32(): Uint32Array {
    const bytes = this.view();
    if (this.wordsSource !== bytes) {
      this.words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
      this.wordsSource = bytes;
    }
    return this.words!;
  }

  get size(): number {
    return this.length;
  }

  /** Arena offset of the first byte, or -1 for host and retired regions. */
  get arenaOffset(): number {
    return this.arena === null ? -1 : this.base;
  }

  /** True once the owning bank has relocated or freed this allocation. */
  get retired(): boolean {
    return this.isRetired;
  }

  /** @internal Moves the bytes out of the arena and returns the range to release. */
  retire(): {base: number; size: number} | null {
    this.isRetired = true;
    const arena = this.arena;
    if (arena === null) return null;
    const current = this.view(),
      copy = new Uint8Array(current.length);
    copyMemoryBytes(copy, 0, current, 0, current.length);
    this.bytes = copy;
    this.arena = null;
    return {base: this.base, size: copy.length};
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
 * The VM storage allocator. Every bank region is created in one arena, relocated and retired
 * here. `initialBytes` is the arena's first reservation; it doubles on demand.
 */
export class BurikoBpRegionTable {
  readonly arena: BurikoBpArena;
  private readonly live = new Set<BurikoBpRegion>();

  constructor(initialBytes = 0x1000) {
    this.arena = new BurikoBpArena(initialBytes);
  }

  /** A zero-filled region. */
  allocate(size: number): BurikoBpRegion {
    const region = BurikoBpRegion.inArena(this.arena, this.arena.allocate(size), size);
    this.live.add(region);
    return region;
  }

  /** A live region holding a copy of `bytes`, provenance included. */
  adopt(bytes: Uint8Array): BurikoBpRegion {
    const region = this.allocate(bytes.length);
    if (bytes.length > 0) copyMemoryBytes(region.view(), 0, bytes, 0, bytes.length);
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
    if (!this.live.delete(region)) return;
    const range = region.retire();
    if (range !== null) this.arena.release(range.base, range.size);
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
