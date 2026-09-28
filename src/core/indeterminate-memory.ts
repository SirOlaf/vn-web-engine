/**
 * Unwritten native outputs have no reproducible numeric value. Their provenance is kept beside
 * storage until a caller overwrites or observes them. Reading a marked byte faults with the
 * reason of the earliest-marked byte among those read; re-marking a byte replaces its reason
 * but keeps its place in mark order.
 *
 * Two stores implement this. Host buffers keep a per-buffer map created on first mark. Buffers
 * registered with an `IndeterminateBitmap` keep one bit per byte in their own storage, plus a
 * side table of mark sequence and reason for the marked bytes only.
 */

/** Reason strings by id; id 0 means determinate. */
const reasons: string[] = [''];
const reasonIds = new Map<string, number>();

/** A small integer standing for `reason`, stable for the life of the page. */
export function internIndeterminateReason(reason: string): number {
  let id = reasonIds.get(reason);
  if (id === undefined) {
    id = reasons.length;
    if (id >= REASON_LIMIT) throw new RangeError('Too many distinct indeterminate-memory reasons');
    reasons.push(reason);
    reasonIds.set(reason, id);
  }
  return id;
}

export function indeterminateReason(id: number): string {
  return reasons[id]!;
}

/** Side-table values pack `sequence * REASON_LIMIT + reasonId`; ordering them orders by sequence. */
const REASON_LIMIT = 0x100000;

interface Store {
  /** Marked byte count; zero makes every query miss. */
  readonly size: number;
  mark(start: number, length: number, reason: number): void;
  clear(start: number, length: number): void;
  has(start: number, length: number): boolean;
  /** Reason id of the earliest-marked byte in the range, or 0. */
  first(start: number, length: number): number;
  /** Marked bytes in the range as [absolute offset, reason id], in mark order. */
  collect(start: number, length: number): [number, number][];
}

/** Host store: byte → packed mark, with bounds that only widen until every mark clears. */
class MarkMap implements Store {
  readonly cells = new Map<number, number>();
  private sequence = 0;
  low = Infinity;
  high = -Infinity;

  get size(): number {
    return this.cells.size;
  }

  /** Exact rejection: no mark can lie in a range outside the widened bounds. */
  private outside(start: number, length: number): boolean {
    return start + length <= this.low || start > this.high;
  }

  mark(start: number, length: number, reason: number): void {
    const cells = this.cells;
    for (let at = start; at < start + length; at++) {
      const packed = cells.get(at);
      cells.set(
        at,
        packed === undefined
          ? this.sequence++ * REASON_LIMIT + reason
          : packed - (packed % REASON_LIMIT) + reason,
      );
    }
    if (length > 0) {
      this.low = Math.min(this.low, start);
      this.high = Math.max(this.high, start + length - 1);
    }
  }

  /** Visits each marked byte in the range: probing short ranges, scanning the marks otherwise. */
  private scan(start: number, length: number, visit: (at: number, packed: number) => void): void {
    if (this.outside(start, length)) return;
    const cells = this.cells;
    if (length < cells.size) {
      for (let at = start; at < start + length; at++) {
        const packed = cells.get(at);
        if (packed !== undefined) visit(at, packed);
      }
    } else
      for (const [at, packed] of cells) if (at >= start && at < start + length) visit(at, packed);
  }

  clear(start: number, length: number): void {
    this.scan(start, length, (at) => this.cells.delete(at));
  }

  has(start: number, length: number): boolean {
    let found = false;
    this.scan(start, length, () => (found = true));
    return found;
  }

  first(start: number, length: number): number {
    let earliest = Infinity;
    this.scan(start, length, (_, packed) => (earliest = Math.min(earliest, packed)));
    return earliest === Infinity ? 0 : earliest % REASON_LIMIT;
  }

  collect(start: number, length: number): [number, number][] {
    const found: [number, number][] = [];
    this.scan(start, length, (at, packed) => found.push([at, packed]));
    return found.sort((a, b) => a[1] - b[1]).map(([at, packed]) => [at, packed % REASON_LIMIT]);
  }
}

const stores = new WeakMap<ArrayBufferLike, Store>();
/** Stores holding at least one mark (a collected host buffer keeps this conservatively
 * positive). Zero proves every lookup would miss, so scalar accesses skip the WeakMap. */
let markedStores = 0;

function storeFor(buffer: ArrayBufferLike): Store | undefined {
  return markedStores === 0 ? undefined : stores.get(buffer);
}

/**
 * Provenance for a buffer that reserves one bit per byte of its first `dataLength` bytes in its
 * own storage (`bits`). A set bit means the byte is marked; the side table holds the mark's
 * sequence and reason. Offsets are absolute within the buffer.
 */
export class IndeterminateBitmap implements Store {
  private buffer: ArrayBufferLike;
  private bits: Uint8Array;
  private dataLength: number;
  private readonly marks = new Map<number, number>();
  private sequence = 0;

  constructor(buffer: ArrayBufferLike, bits: Uint8Array, dataLength: number) {
    this.buffer = buffer;
    this.bits = bits;
    this.dataLength = dataLength;
    stores.set(buffer, this);
  }

  get size(): number {
    return this.marks.size;
  }

  /** The owner moved the storage (bitmap included) to `buffer`; offsets are unchanged. */
  rebind(buffer: ArrayBufferLike, bits: Uint8Array, dataLength: number): void {
    stores.delete(this.buffer);
    this.buffer = buffer;
    this.bits = bits;
    this.dataLength = dataLength;
    stores.set(buffer, this);
  }

  /** Clamps a range to the covered bytes; returns its end, or `start` when empty. */
  private end(start: number, length: number): number {
    return Math.min(start + length, this.dataLength);
  }

  mark(start: number, length: number, reason: number): void {
    const bits = this.bits,
      end = this.end(start, length),
      wasEmpty = this.marks.size === 0;
    for (let at = Math.max(start, 0); at < end; at++) {
      const mask = 1 << (at & 7);
      if ((bits[at >> 3]! & mask) !== 0) {
        const packed = this.marks.get(at)!;
        this.marks.set(at, packed - (packed % REASON_LIMIT) + reason);
      } else {
        bits[at >> 3] = bits[at >> 3]! | mask;
        this.marks.set(at, this.sequence++ * REASON_LIMIT + reason);
      }
    }
    if (wasEmpty && this.marks.size !== 0) markedStores++;
  }

  /** Calls `visit` for each marked byte in the range, skipping unmarked bitmap bytes whole. */
  private scan(start: number, length: number, visit: (at: number) => boolean | void): void {
    const bits = this.bits,
      end = this.end(start, length);
    for (let at = Math.max(start, 0); at < end;) {
      const byte = bits[at >> 3]!;
      if (byte === 0) {
        at = (at | 7) + 1;
        continue;
      }
      if ((byte & (1 << (at & 7))) !== 0 && visit(at) === true) return;
      at++;
    }
  }

  clear(start: number, length: number): void {
    if (this.marks.size === 0) return;
    const bits = this.bits;
    this.scan(start, length, (at) => {
      bits[at >> 3] = bits[at >> 3]! & ~(1 << (at & 7));
      this.marks.delete(at);
    });
    if (this.marks.size === 0) markedStores--;
  }

  has(start: number, length: number): boolean {
    if (this.marks.size === 0) return false;
    let found = false;
    this.scan(start, length, () => (found = true));
    return found;
  }

  first(start: number, length: number): number {
    if (this.marks.size === 0) return 0;
    const bits = this.bits,
      end = this.end(start, length);
    let earliest = Infinity;
    for (let at = Math.max(start, 0); at < end;) {
      const byte = bits[at >> 3]!;
      if (byte === 0) at = (at | 7) + 1;
      else {
        if ((byte & (1 << (at & 7))) !== 0) earliest = Math.min(earliest, this.marks.get(at)!);
        at++;
      }
    }
    return earliest === Infinity ? 0 : earliest % REASON_LIMIT;
  }

  collect(start: number, length: number): [number, number][] {
    if (this.marks.size === 0) return [];
    const found: [number, number][] = [];
    this.scan(start, length, (at) => {
      found.push([at, this.marks.get(at)!]);
    });
    found.sort((a, b) => a[1] - b[1]);
    return found.map(([at, packed]) => [at, packed % REASON_LIMIT]);
  }
}

function markRange(bytes: Uint8Array, start: number, length: number, reason: number): void {
  let store = stores.get(bytes.buffer);
  if (!store) {
    const map = new MarkMap();
    stores.set(bytes.buffer, (store = map));
    markedStores++;
  }
  store.mark(start, length, reason);
}

function clearRange(store: Store, buffer: ArrayBufferLike, start: number, length: number): void {
  store.clear(start, length);
  if (store instanceof MarkMap && store.size === 0 && stores.delete(buffer)) markedStores--;
}

export function markIndeterminateMemory(
  bytes: Uint8Array,
  offset: number,
  length: number,
  reason: string,
): void {
  markRange(bytes, bytes.byteOffset + offset, length, internIndeterminateReason(reason));
}

export function clearIndeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const store = storeFor(bytes.buffer);
  if (store) clearRange(store, bytes.buffer, bytes.byteOffset + offset, length);
}

/** Inspect provenance without observing or clearing the covered bytes. */
export function hasIndeterminateMemory(bytes: Uint8Array, offset: number, length: number): boolean {
  const store = storeFor(bytes.buffer);
  return store !== undefined && store.has(bytes.byteOffset + offset, length);
}

/** Faults with the reason of the earliest marked covered byte in mark order. */
export function requireDeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const store = storeFor(bytes.buffer);
  if (store === undefined) return;
  const reason = store.first(bytes.byteOffset + offset, length);
  if (reason !== 0) throw new Error(reasons[reason]);
}

/** DataView access checks the bytes actually read and clears only completed writes. */
class ProvenanceDataView extends DataView<ArrayBufferLike> {}

for (const [type, width] of [
  ['Int8', 1],
  ['Uint8', 1],
  ['Int16', 2],
  ['Uint16', 2],
  ['Int32', 4],
  ['Uint32', 4],
  ['Float32', 4],
  ['Float64', 8],
  ['BigInt64', 8],
  ['BigUint64', 8],
] as const) {
  for (const operation of ['get', 'set'] as const) {
    const name = `${operation}${type}` as keyof DataView;
    const native = DataView.prototype[name] as (...args: unknown[]) => unknown;
    Object.defineProperty(ProvenanceDataView.prototype, name, {
      value(this: DataView, offset: number, ...args: unknown[]) {
        // Native bounds and coercion faults take precedence over provenance.
        const result = native.call(this, offset, ...args);
        const store = storeFor(this.buffer);
        if (store === undefined) return result;
        const start = this.byteOffset + Math.trunc(offset);
        if (operation === 'get') {
          const reason = store.first(start, width);
          if (reason !== 0) throw new Error(reasons[reason]);
        } else clearRange(store, this.buffer, start, width);
        return result;
      },
      writable: true,
      configurable: true,
    });
  }
}

export function provenanceDataView(bytes: Uint8Array, offset: number, length: number): DataView {
  return new ProvenanceDataView(bytes.buffer, bytes.byteOffset + offset, length);
}

/** Byte transport preserves provenance, including overlapping copies. */
export function copyMemoryBytes(
  destination: Uint8Array,
  destinationOffset: number,
  source: Uint8Array,
  sourceOffset: number,
  length: number,
): void {
  const store = storeFor(source.buffer);
  const start = source.byteOffset + sourceOffset;
  const marks = store === undefined ? [] : store.collect(start, length);
  destination.set(source.subarray(sourceOffset, sourceOffset + length), destinationOffset);
  clearIndeterminateMemory(destination, destinationOffset, length);
  const base = destination.byteOffset + destinationOffset - start;
  for (const [at, reason] of marks) markRange(destination, base + at, 1, reason);
}
