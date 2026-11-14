/**
 * The core's native address space for pixel storage. Bitmap bits live in one
 * `WebAssembly.Memory`, so a bitmap's address (`Layer.mainImageBuffer`, `Bitmap.buffer`,
 * `Rect.nativeArray`) is a byte offset that plugins and kernels share, as native pointers are.
 * A Wasm kernel module imports the same memory and works on bitmaps in place.
 *
 * Addresses start above zero, so 0 stays the null pointer. Allocation never grows the memory
 * after creation; see `WasmResidentHeap`.
 */
import {WasmResidentHeap} from '../../../../graphics/wasm-resident-heap.js';
import {TjsError} from '../../tjs2/runtime/errors.js';

const PAGE = 65536;
/** Default reservation: a 32-bit process's bitmap heap (`-bitmapheapsize` is not used). */
const DEFAULT_BUDGET = 1024 * 1024 * 1024;

export class TvpMemory {
  readonly memory: WebAssembly.Memory;
  readonly #heap: WasmResidentHeap;
  #u8: Uint8Array;
  #u32: Uint32Array;
  #i32: Int32Array;
  readonly #handles = new Map<number, object>();
  readonly #handleOf = new WeakMap<object, number>();

  private constructor(memory: WebAssembly.Memory, heap: WasmResidentHeap) {
    this.memory = memory;
    this.#heap = heap;
    this.#u8 = new Uint8Array(memory.buffer);
    this.#u32 = new Uint32Array(memory.buffer);
    this.#i32 = new Int32Array(memory.buffer);
  }

  /** Reserves up to `budget` bytes (halving down to 64 MiB where the host refuses). */
  static create(budget = DEFAULT_BUDGET): TvpMemory {
    const maximum = Math.ceil((budget + PAGE) / PAGE);
    const memory = new WebAssembly.Memory({initial: 1, maximum});
    // The first 64 bytes are never handed out: address 0 is null.
    const heap = WasmResidentHeap.create(
      {memory, __heap_base: {value: 64} as unknown as WebAssembly.Global} as never,
      budget,
    );
    if (!heap) throw new Error('TvpMemory: no memory reservation available');
    return new TvpMemory(memory, heap);
  }

  /** Bytes of the whole memory (views stay valid: the memory never grows after creation). */
  get u8(): Uint8Array {
    return this.#u8;
  }
  get u32(): Uint32Array {
    return this.#u32;
  }
  get i32(): Int32Array {
    return this.#i32;
  }

  /**
   * Allocates `length` zeroed bytes and returns their address (64-byte aligned). Throws the
   * native allocation failure when the reservation is exhausted.
   */
  allocate(length: number, what = 'TVPAllocBitmapBits'): number {
    const bytes = this.#heap.allocate(Math.max(1, length));
    if (!bytes) throw new TjsError(`Cannot allocate memory: ${what} (${length} bytes)`);
    return bytes.byteOffset;
  }

  /** Frees a block from `allocate`. */
  free(address: number, length: number): void {
    this.#heap.release(new Uint8Array(this.memory.buffer, address, Math.max(1, length)));
  }

  get liveBytes(): number {
    return this.#heap.liveBytes;
  }

  /**
   * An interface pointer for `object` (`layerTreeOwnerInterface`, a draw device's `interface`):
   * a unique non-null address, stable for the object's lifetime.
   */
  handleOf(object: object): number {
    let h = this.#handleOf.get(object);
    if (h === undefined) {
      h = this.allocate(4, 'interface');
      this.#handleOf.set(object, h);
      this.#handles.set(h, object);
    }
    return h;
  }

  /** The object behind an interface pointer, or null. */
  objectAt<T extends object>(handle: number): T | null {
    return (this.#handles.get(handle) as T | undefined) ?? null;
  }

  /** Forgets an interface pointer (the object is destroyed). */
  releaseHandle(object: object): void {
    const h = this.#handleOf.get(object);
    if (h === undefined) return;
    this.#handleOf.delete(object);
    this.#handles.delete(h);
    this.free(h, 4);
  }
}
