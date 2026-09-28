interface CachedByteView {
  offset: number;
  length: number;
  view: DataView;
}

const byteViews = new WeakMap<Uint8Array, CachedByteView>();

/** Reuse the wrapper, never the contents; resized and replaced byte views remain live. */
export function byteDataView(bytes: Uint8Array): DataView {
  const length = bytes.byteLength,
    cached = byteViews.get(bytes);
  // A nonempty typed view keeps its buffer and offset through resizes. Empty
  // views also need the offset check because shrinking out of bounds resets it.
  if (cached && cached.length === length && (length !== 0 || cached.offset === bytes.byteOffset))
    return cached.view;
  const offset = bytes.byteOffset,
    view = new DataView(bytes.buffer, offset, length);
  byteViews.set(bytes, {offset, length, view});
  return view;
}

/**
 * Whether two byte spans can share memory: the same buffer and intersecting absolute ranges.
 * Resident pixel storage shares one buffer between many owners, so buffer identity alone is
 * not an alias test. Empty spans never overlap.
 */
export function byteSpansOverlap(
  first: ArrayBufferLike,
  firstStart: number,
  firstLength: number,
  second: ArrayBufferLike,
  secondStart: number,
  secondLength: number,
): boolean {
  return (
    first === second &&
    firstLength > 0 &&
    secondLength > 0 &&
    firstStart < secondStart + secondLength &&
    secondStart < firstStart + firstLength
  );
}

/** byteSpansOverlap for two whole typed or DataView views. */
export function viewsOverlap(first: ArrayBufferView, second: ArrayBufferView): boolean {
  return byteSpansOverlap(
    first.buffer,
    first.byteOffset,
    first.byteLength,
    second.buffer,
    second.byteOffset,
    second.byteLength,
  );
}

/** First zero byte in a validity mask or binary span, without per-byte bulk scanning. */
export function indexOfZeroByte(bytes: Uint8Array): number {
  let index = 0;
  const prefix = Math.min(bytes.length, (4 - (bytes.byteOffset & 3)) & 3);
  for (; index < prefix; index++) if (bytes[index] === 0) return index;
  const count = Math.floor((bytes.length - index) / 4);
  if (count !== 0 && bytes.buffer instanceof ArrayBuffer) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset + index, count);
    for (let wordIndex = 0; wordIndex < count; wordIndex++) {
      const word = words[wordIndex]!;
      // A borrow into a byte's high bit, with that bit initially clear, detects
      // a zero lane. Inspect candidate bytes in address order on either endian host.
      if (((word - 0x01010101) & ~word & 0x80808080) !== 0) {
        const start = index + wordIndex * 4;
        for (let byte = start; byte < start + 4; byte++) if (bytes[byte] === 0) return byte;
      }
    }
    index += count * 4;
  }
  for (; index < bytes.length; index++) if (bytes[index] === 0) return index;
  return -1;
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
