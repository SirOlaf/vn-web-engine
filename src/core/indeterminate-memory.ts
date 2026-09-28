/** Marked byte addresses in mark order, with bounds that only widen until every mark clears. */
class Marks extends Map<number, string> {
  low = Infinity;
  high = -Infinity;
}

/** Unwritten native outputs have no reproducible numeric value. Keep their
 * provenance beside storage until a caller overwrites or observes them. */
const unwritten = new WeakMap<ArrayBufferLike, Marks>();

// Scalar accesses repeat on one buffer; remember its lookup until the map changes.
let recentBuffer: ArrayBufferLike | undefined;
let recentMarks: Marks | undefined;
function marksFor(buffer: ArrayBufferLike): Marks | undefined {
  if (buffer !== recentBuffer) {
    recentBuffer = buffer;
    recentMarks = unwritten.get(buffer);
  }
  return recentMarks;
}
/** Exact rejection: no mark can lie in a range outside the widened bounds. */
function outside(marks: Marks, start: number, length: number): boolean {
  return start + length <= marks.low || start > marks.high;
}

export function markIndeterminateMemory(
  bytes: Uint8Array,
  offset: number,
  length: number,
  reason: string,
): void {
  let cells = marksFor(bytes.buffer);
  if (!cells) {
    unwritten.set(bytes.buffer, (cells = new Marks()));
    recentBuffer = undefined;
  }
  const start = bytes.byteOffset + offset;
  for (let i = 0; i < length; i++) cells.set(start + i, reason);
  if (length > 0) {
    cells.low = Math.min(cells.low, start);
    cells.high = Math.max(cells.high, start + length - 1);
  }
}

// Ranges shorter than the marked set probe their own bytes; longer ranges scan the marks.
export function clearIndeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const cells = marksFor(bytes.buffer);
  if (!cells) return;
  const start = bytes.byteOffset + offset;
  if (outside(cells, start, length)) return;
  if (length < cells.size) for (let at = start; at < start + length; at++) cells.delete(at);
  else for (const at of cells.keys()) if (at >= start && at < start + length) cells.delete(at);
  if (!cells.size) {
    unwritten.delete(bytes.buffer);
    recentBuffer = undefined;
  }
}

/** Inspect provenance without observing or clearing the covered bytes. */
export function hasIndeterminateMemory(bytes: Uint8Array, offset: number, length: number): boolean {
  const cells = marksFor(bytes.buffer);
  if (!cells) return false;
  const start = bytes.byteOffset + offset;
  if (outside(cells, start, length)) return false;
  if (length < cells.size) {
    for (let at = start; at < start + length; at++) if (cells.has(at)) return true;
    return false;
  }
  for (const at of cells.keys()) if (at >= start && at < start + length) return true;
  return false;
}

/** Faults with the reason of the earliest marked covered byte in mark order. */
export function requireDeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const cells = marksFor(bytes.buffer);
  if (!cells) return;
  const start = bytes.byteOffset + offset;
  if (outside(cells, start, length)) return;
  if (length < cells.size) {
    let found: string | undefined,
      mixed = false;
    for (let at = start; at < start + length; at++) {
      const reason = cells.get(at);
      if (reason === undefined) continue;
      if (found === undefined) found = reason;
      else if (reason !== found) mixed = true;
    }
    if (found === undefined) return;
    if (!mixed) throw new Error(found);
  }
  for (const [at, reason] of cells) if (at >= start && at < start + length) throw new Error(reason);
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
        if (!marksFor(this.buffer)) return result;
        const bytes = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);
        if (operation === 'get') requireDeterminateMemory(bytes, Math.trunc(offset), width);
        else clearIndeterminateMemory(bytes, Math.trunc(offset), width);
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
  const cells = marksFor(source.buffer);
  const start = source.byteOffset + sourceOffset;
  let marks: [number, string][] = [];
  if (cells && length < cells.size) {
    for (let at = start; at < start + length; at++) {
      const reason = cells.get(at);
      if (reason !== undefined) marks.push([at, reason]);
    }
    // Mark order selects between differing reasons; only a scan recovers it.
    if (marks.some(([, reason]) => reason !== marks[0]![1]))
      marks = [...cells].filter(([at]) => at >= start && at < start + length);
  } else if (cells) marks = [...cells].filter(([at]) => at >= start && at < start + length);
  destination.set(source.subarray(sourceOffset, sourceOffset + length), destinationOffset);
  clearIndeterminateMemory(destination, destinationOffset, length);
  for (const [at, reason] of marks)
    markIndeterminateMemory(destination, destinationOffset + at - start, 1, reason);
}
