/** Unwritten native outputs have no reproducible numeric value. Keep their
 * provenance beside storage until a caller overwrites or observes them. */
const unwritten = new WeakMap<ArrayBufferLike, Map<number, string>>();

export function markIndeterminateMemory(
  bytes: Uint8Array,
  offset: number,
  length: number,
  reason: string,
): void {
  let cells = unwritten.get(bytes.buffer);
  if (!cells) unwritten.set(bytes.buffer, (cells = new Map()));
  for (let i = 0; i < length; i++) cells.set(bytes.byteOffset + offset + i, reason);
}

export function clearIndeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const cells = unwritten.get(bytes.buffer);
  if (!cells) return;
  const start = bytes.byteOffset + offset;
  for (const at of cells.keys()) if (at >= start && at < start + length) cells.delete(at);
  if (!cells.size) unwritten.delete(bytes.buffer);
}

export function requireDeterminateMemory(bytes: Uint8Array, offset: number, length: number): void {
  const cells = unwritten.get(bytes.buffer);
  if (!cells) return;
  const start = bytes.byteOffset + offset;
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
        if (!unwritten.has(this.buffer)) return result;
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
  const cells = unwritten.get(source.buffer);
  const start = source.byteOffset + sourceOffset;
  const marks = cells ? [...cells].filter(([at]) => at >= start && at < start + length) : [];
  destination.set(source.subarray(sourceOffset, sourceOffset + length), destinationOffset);
  clearIndeterminateMemory(destination, destinationOffset, length);
  for (const [at, reason] of marks)
    markIndeterminateMemory(destination, destinationOffset + at - start, 1, reason);
}
