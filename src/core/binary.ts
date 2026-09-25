interface CachedByteView {
  buffer: ArrayBufferLike;
  offset: number;
  length: number;
  view: DataView;
}

const byteViews = new WeakMap<Uint8Array, CachedByteView>();

/** Reuse the wrapper, never the contents; resized and replaced byte views remain live. */
export function byteDataView(bytes: Uint8Array): DataView {
  const buffer = bytes.buffer,
    offset = bytes.byteOffset,
    length = bytes.byteLength,
    cached = byteViews.get(bytes);
  if (cached && cached.buffer === buffer && cached.offset === offset && cached.length === length)
    return cached.view;
  const view = new DataView(buffer, offset, length);
  byteViews.set(bytes, {buffer, offset, length, view});
  return view;
}

export function checkRange(size: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > size - length
  )
    throw new Error(`Invalid range ${offset}+${length} of ${size}`);
}
export function safeNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Integer exceeds exact JS range: ${value}`);
  return n;
}
export function ascii(b: Uint8Array, start = 0, length = b.length - start): string {
  checkRange(b.length, start, length);
  return Array.from(b.subarray(start, start + length), (v) => String.fromCharCode(v)).join('');
}
export class BinaryReader {
  readonly view: DataView;
  position = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly littleEndian = false,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  take(length: number): number {
    checkRange(this.bytes.length, this.position, length);
    const p = this.position;
    this.position += length;
    return p;
  }
  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  i8(): number {
    return this.view.getInt8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2), this.littleEndian);
  }
  i16(): number {
    return this.view.getInt16(this.take(2), this.littleEndian);
  }
  u32(): number {
    return this.view.getUint32(this.take(4), this.littleEndian);
  }
  i32(): number {
    return this.view.getInt32(this.take(4), this.littleEndian);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8), this.littleEndian);
  }
  i64(): bigint {
    return this.view.getBigInt64(this.take(8), this.littleEndian);
  }
  f32(): number {
    return this.view.getFloat32(this.take(4), this.littleEndian);
  }
  f64(): number {
    return this.view.getFloat64(this.take(8), this.littleEndian);
  }
}
