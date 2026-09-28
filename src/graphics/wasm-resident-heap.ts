/** Linear-memory exports of a kernel instance that can host resident pixel storage. */
export interface WasmResidentExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
}

/** Block alignment; covers SIMD loads and keeps row starts of packed RGB32 rows aligned. */
const ALIGNMENT = 64;
const PAGE = 65536;

interface FreeBlock {
  start: number;
  length: number;
}

/**
 * Long-lived pixel storage inside one kernel instance's linear memory, so kernels address
 * resident rows in place instead of staging them per call.
 *
 * The heap reserves its whole budget with one `grow` when it is created and never grows
 * again. The memory's `ArrayBuffer` therefore never detaches, and it stays an ordinary
 * fixed-length buffer: JavaScript pixel loops over resident views keep the speed of any
 * other buffer, which views on a resizable buffer do not. Untouched pages cost no physical
 * memory. Nothing else may grow this instance's memory.
 *
 * Allocation is first fit over address-ordered free blocks, then a bump region. Returned
 * bytes are zero, as a fresh `Uint8Array` would be. Freed blocks are reused.
 */
export class WasmResidentHeap {
  /** The buffer every resident view shares. */
  readonly buffer: ArrayBuffer;
  private readonly end: number;
  private top: number;
  /** Bytes below this address may hold old pixels; the bump region above it is still zero. */
  private dirtyTop: number;
  private readonly free: FreeBlock[] = [];
  private live = 0;
  private peak = 0;

  private constructor(memory: WebAssembly.Memory, start: number) {
    this.buffer = memory.buffer;
    this.end = this.buffer.byteLength;
    this.top = this.dirtyTop = start;
  }

  /**
   * Reserves up to `budget` bytes after the module's own data. When the reservation fails,
   * smaller halves are tried down to `minimum`; below that there is no heap and callers keep
   * ordinary per-owner buffers.
   */
  static create(
    exports: WasmResidentExports,
    budget: number,
    minimum = Math.min(budget, 64 * 1024 * 1024),
  ): WasmResidentHeap | null {
    const memory = exports.memory,
      start = Math.ceil(Number(exports.__heap_base.value) / ALIGNMENT) * ALIGNMENT;
    for (let size = budget; size >= minimum; size = Math.floor(size / 2)) {
      const pages = Math.ceil((start + size - memory.buffer.byteLength) / PAGE);
      try {
        if (pages > 0) memory.grow(pages);
        return new WasmResidentHeap(memory, start);
      } catch {
        // Address space or the declared maximum refused this size; try a smaller one.
      }
    }
    return null;
  }

  /** Bytes currently allocated. */
  get liveBytes(): number {
    return this.live;
  }
  /** Largest `liveBytes` so far. */
  get peakBytes(): number {
    return this.peak;
  }
  /** Linear memory reserved for the heap and the module's own data. */
  get capacityBytes(): number {
    return this.end;
  }

  /** Zeroed resident bytes, or null when the reservation has no block left for them. */
  allocate(length: number): Uint8Array | null {
    if (!Number.isSafeInteger(length) || length <= 0) return null;
    const size = Math.ceil(length / ALIGNMENT) * ALIGNMENT;
    let address = -1;
    for (let index = 0; index < this.free.length; index++) {
      const block = this.free[index]!;
      if (block.length < size) continue;
      address = block.start;
      if (block.length === size) this.free.splice(index, 1);
      else {
        block.start += size;
        block.length -= size;
      }
      break;
    }
    if (address < 0) {
      if (this.top + size > this.end) return null;
      address = this.top;
      this.top += size;
    }
    const bytes = new Uint8Array(this.buffer, address, length);
    // Reused addresses may hold another owner's pixels; untouched memory is already zero.
    if (address < this.dirtyTop) bytes.fill(0, 0, Math.min(length, this.dirtyTop - address));
    this.dirtyTop = Math.max(this.dirtyTop, address + size);
    this.live += size;
    this.peak = Math.max(this.peak, this.live);
    return bytes;
  }

  /** Returns a block from `allocate`. The owner must not use any view of it afterwards. */
  release(bytes: Uint8Array): void {
    if (bytes.buffer !== this.buffer) throw new Error('Released bytes are not resident');
    const start = bytes.byteOffset,
      length = Math.ceil(bytes.byteLength / ALIGNMENT) * ALIGNMENT;
    this.live -= length;
    let index = 0;
    while (index < this.free.length && this.free[index]!.start < start) index++;
    const previous = this.free[index - 1],
      next = this.free[index];
    if (previous !== undefined && previous.start + previous.length === start) {
      previous.length += length;
      if (next !== undefined && previous.start + previous.length === next.start) {
        previous.length += next.length;
        this.free.splice(index, 1);
      }
    } else if (next !== undefined && start + length === next.start) {
      next.start = start;
      next.length += length;
    } else this.free.splice(index, 0, {start, length});
    // A free block at the end returns to the bump region.
    const last = this.free.at(-1);
    if (last !== undefined && last.start + last.length === this.top) {
      this.top = last.start;
      this.free.pop();
    }
  }

  /** Whether a view lies in this heap's memory. */
  contains(view: ArrayBufferView): boolean {
    return view.buffer === this.buffer;
  }
}
