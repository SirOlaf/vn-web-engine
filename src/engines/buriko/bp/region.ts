import {
  clearIndeterminateMemory,
  copyMemoryBytes,
  IndeterminateBitmap,
} from '../../../core/indeterminate-memory.js';

/** Region bases are aligned for 32/64-bit typed views and wasm loads. */
const ALIGNMENT = 16;

interface FreeBlock {
  offset: number;
  size: number;
}

/** `ArrayBuffer.prototype.transfer` (ES2024) reallocates in place where possible and detaches the source. */
type TransferableBuffer = ArrayBuffer & {transfer?: (length: number) => ArrayBuffer};

/** Whole-arena access for code that addresses the arena directly, such as a wasm module. */
export interface BurikoBpArenaViews {
  readonly bytes: Uint8Array;
  readonly words: Uint32Array;
  /** Byte offset of the indeterminate-byte bitmap: bit `a & 7` of byte `bitmapOffset + (a >> 3)`
   * is set while arena byte `a` holds an unwritten value. */
  readonly bitmapOffset: number;
  readonly generation: number;
}

/**
 * One growable `ArrayBuffer` holding every live region of a region table. Regions are placed
 * first fit at 16-byte aligned offsets within the first `capacity` bytes; the remaining
 * `capacity / 8` bytes are the provenance bitmap for those bytes. Growth reallocates the buffer,
 * detaching the previous one where the platform supports it, moves the bitmap to the new data
 * end and advances `generation`; the owning table then re-derives every live region's views.
 */
export class BurikoBpArena {
  buffer: ArrayBuffer;
  generation = 0;
  private dataBytes: number;
  private readonly free: FreeBlock[];
  private readonly provenance: IndeterminateBitmap;
  private wholeViews: BurikoBpArenaViews;
  private readonly memory: WebAssembly.Memory | null;

  /**
   * Without `wasm`, the arena is a plain `ArrayBuffer`. With it, the arena is that
   * `WebAssembly.Memory` (sized by `wasmPages`), and its first `reserved` bytes belong to the
   * module's own data and stack.
   */
  constructor(initialBytes: number, wasm?: {memory: WebAssembly.Memory; reserved: number}) {
    this.memory = wasm?.memory ?? null;
    if (this.memory !== null) {
      this.buffer = this.memory.buffer;
      this.dataBytes = layoutCapacity(this.buffer.byteLength);
    } else {
      this.dataBytes = Math.max(ALIGNMENT, roundUp(initialBytes));
      this.buffer = new ArrayBuffer(this.dataBytes + this.dataBytes / 8);
    }
    const reserved = roundUp(wasm?.reserved ?? 0);
    if (reserved >= this.dataBytes)
      throw new RangeError('Buriko arena has no room after its reservation');
    this.free = [{offset: reserved, size: this.dataBytes - reserved}];
    this.provenance = new IndeterminateBitmap(this.buffer, this.bitmap(), this.dataBytes);
    this.wholeViews = this.createViews();
  }

  /** Initial `WebAssembly.Memory` pages for an arena of at least `initialBytes` regions. */
  static wasmPages(initialBytes: number): number {
    return Math.ceil((roundUp(initialBytes) * 9) / 8 / WASM_PAGE);
  }

  /** Bytes available to regions. */
  get capacity(): number {
    return this.dataBytes;
  }

  /** Arena bytes currently holding an unwritten value. */
  get indeterminateBytes(): number {
    return this.provenance.size;
  }

  private bitmap(): Uint8Array {
    return new Uint8Array(this.buffer, this.dataBytes, this.dataBytes / 8);
  }

  private createViews(): BurikoBpArenaViews {
    return {
      bytes: new Uint8Array(this.buffer),
      words: new Uint32Array(this.buffer),
      bitmapOffset: this.dataBytes,
      generation: this.generation,
    };
  }

  /** Whole-arena views for the current generation. Invalid after any VM allocation. */
  views(): BurikoBpArenaViews {
    if (this.wholeViews.generation !== this.generation) this.wholeViews = this.createViews();
    return this.wholeViews;
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
      oldCapacity = this.dataBytes;
    const last = this.free.at(-1);
    const tail = last && last.offset + last.size === oldCapacity ? last.size : 0;
    let capacity = oldCapacity * 2;
    while (capacity - oldCapacity + tail < reserved) capacity *= 2;
    let next: ArrayBuffer;
    if (this.memory !== null) {
      const pages = Math.ceil((capacity * 9) / 8 / WASM_PAGE);
      this.memory.grow(pages - previous.byteLength / WASM_PAGE);
      next = this.memory.buffer;
      capacity = layoutCapacity(next.byteLength);
    } else {
      const length = capacity + capacity / 8;
      const transfer = (previous as TransferableBuffer).transfer;
      if (typeof transfer === 'function') next = transfer.call(previous, length);
      else {
        next = new ArrayBuffer(length);
        new Uint8Array(next).set(new Uint8Array(previous));
      }
    }
    // The old bitmap now lies in free data space; it moves to the new data end, and the bits
    // for the added bytes are the zeroed tail of the new buffer.
    const bytes = new Uint8Array(next);
    bytes.copyWithin(capacity, oldCapacity, oldCapacity + oldCapacity / 8);
    bytes.fill(0, oldCapacity, oldCapacity + oldCapacity / 8);
    this.buffer = next;
    this.dataBytes = capacity;
    this.provenance.rebind(next, this.bitmap(), capacity);
    this.generation++;
    if (tail !== 0) last!.size += capacity - oldCapacity;
    else this.free.push({offset: oldCapacity, size: capacity - oldCapacity});
    return this.free.length - 1;
  }
}

const WASM_PAGE = 0x10000;

/** Data bytes of a `length`-byte arena buffer: the largest 16-byte multiple whose bitmap fits after it. */
function layoutCapacity(length: number): number {
  return Math.floor((length * 8) / 9 / ALIGNMENT) * ALIGNMENT;
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
  private inArena = false;
  private base = 0;
  private readonly length: number;
  private isRetired = false;
  /** Called after `rebase`, for an owner that caches this region's views in its own fields. */
  onRebase: (() => void) | null = null;

  /** A host region over `bytes`. */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.length = bytes.length;
  }

  /** @internal A region at `base` in `arena`; created by `BurikoBpRegionTable`. */
  static inArena(arena: BurikoBpArena, base: number, size: number): BurikoBpRegion {
    const region = new BurikoBpRegion(new Uint8Array(arena.buffer, base, size));
    region.inArena = true;
    region.base = base;
    return region;
  }

  /**
   * The region's bytes. A view obtained inside one synchronous handler stays valid until that
   * handler returns or allocates VM storage; state kept across calls or awaits holds the region.
   */
  view(): Uint8Array {
    return this.bytes;
  }

  /** The region as little-endian 32-bit cells; same validity as `view`. */
  view32(): Uint32Array {
    if (this.words === null)
      this.words = new Uint32Array(this.bytes.buffer, this.bytes.byteOffset, this.length >>> 2);
    return this.words;
  }

  get size(): number {
    return this.length;
  }

  /** Arena offset of the first byte, or -1 for host and retired regions. */
  get arenaOffset(): number {
    return this.inArena ? this.base : -1;
  }

  /** True once the owning bank has relocated or freed this allocation. */
  get retired(): boolean {
    return this.isRetired;
  }

  /** @internal Re-derives the views after the arena reallocated its buffer. */
  rebase(buffer: ArrayBuffer): void {
    this.bytes = new Uint8Array(buffer, this.base, this.length);
    if (this.words !== null) this.words = new Uint32Array(buffer, this.base, this.length >>> 2);
    this.onRebase?.();
  }

  /** @internal Moves the bytes out of the arena and returns the range to release. */
  retire(): {base: number; size: number} | null {
    this.isRetired = true;
    if (!this.inArena) return null;
    const copy = new Uint8Array(this.length);
    copyMemoryBytes(copy, 0, this.bytes, 0, this.length);
    this.bytes = copy;
    if (this.words !== null) this.words = new Uint32Array(copy.buffer, 0, this.length >>> 2);
    this.inArena = false;
    return {base: this.base, size: this.length};
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

  constructor(initialBytes = 0x1000, wasm?: {memory: WebAssembly.Memory; reserved: number}) {
    this.arena = new BurikoBpArena(initialBytes, wasm);
  }

  /** A zero-filled region. Growth re-derives every live region's views before returning. */
  allocate(size: number): BurikoBpRegion {
    const generation = this.arena.generation;
    const base = this.arena.allocate(size);
    if (this.arena.generation !== generation)
      for (const region of this.live) region.rebase(this.arena.buffer);
    const region = BurikoBpRegion.inArena(this.arena, base, size);
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
