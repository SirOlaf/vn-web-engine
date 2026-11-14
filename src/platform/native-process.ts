/**
 * The address space and code addresses of the emulated Windows process that native library
 * reimplementations share. Native code passes pointers as integers: buffers and structures
 * (`RECT`, `NMHDR`, `DRAWITEMSTRUCT`), strings, and function pointers (window procedures,
 * message receivers). Libraries agree on what those integers mean only through this process.
 */

/** The process's linear memory. Address 0 is never handed out. */
export interface NativeAddressSpace {
  /** Bytes of the whole space; the view stays valid (the space does not grow). */
  readonly u8: Uint8Array;
  /** Allocates `length` zeroed bytes; throws when the space is exhausted. */
  allocate(length: number, what?: string): number;
  /** Frees a block from `allocate`. */
  free(address: number, length: number): void;
}

/** First code address handed out: inside the 32-bit user range, clear of heap addresses. */
const CODE_BASE = 0x7e000000;
const CODE_ALIGN = 0x10;

/**
 * Function pointers: a function gets a stable, unique, non-zero address that other libraries
 * resolve back to it (`GWL_WNDPROC`, `CallWindowProc`, `registerMessageReceiver`).
 */
export class NativeCodePointers {
  readonly #byFunction = new Map<object, number>();
  readonly #byAddress = new Map<number, object>();
  #next = CODE_BASE;

  /** The address of `fn`, assigned on first use. */
  pointerOf(fn: object): number {
    let p = this.#byFunction.get(fn);
    if (p === undefined) {
      p = this.#next;
      this.#next += CODE_ALIGN;
      this.#byFunction.set(fn, p);
      this.#byAddress.set(p, fn);
    }
    return p;
  }

  /** The function at `address`, or null. */
  functionAt<F extends object>(address: number): F | null {
    return (this.#byAddress.get(address >>> 0) as F | undefined) ?? null;
  }
}

/** UTF-16LE text at `address` up to the first NUL (`maxChars` caps the length). */
export function readWideString(
  memory: NativeAddressSpace,
  address: number,
  maxChars = Number.MAX_SAFE_INTEGER,
): string {
  const u8 = memory.u8;
  let out = '';
  for (let i = 0, a = address; i < maxChars; i++, a += 2) {
    const c = u8[a]! | (u8[a + 1]! << 8);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Writes `text` and a NUL as UTF-16LE; returns the number of characters written. */
export function writeWideString(memory: NativeAddressSpace, address: number, text: string): number {
  const u8 = memory.u8;
  let a = address;
  for (let i = 0; i < text.length; i++, a += 2) {
    const c = text.charCodeAt(i);
    u8[a] = c & 0xff;
    u8[a + 1] = c >>> 8;
  }
  u8[a] = 0;
  u8[a + 1] = 0;
  return text.length;
}

/**
 * C++ objects that native code reaches through pointers (interface pointers such as a draw
 * device's `iTVPDrawDevice*`): a unique address per object, resolved back to the object.
 */
export interface NativeObjectPointers {
  handleOf(object: object): number;
  objectAt<T extends object>(address: number): T | null;
}

/** The process shared by the libraries of one loader. */
export interface NativeProcess {
  readonly memory: NativeAddressSpace;
  readonly code: NativeCodePointers;
  readonly objects: NativeObjectPointers;
}
