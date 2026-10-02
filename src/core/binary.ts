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
/** Builds the error a ByteView throws for a read outside its limit. */
export type ByteRangeError = (offset: number, length: number, end: number) => Error;

const invalidRange: ByteRangeError = (offset, length, end) =>
  new RangeError(`Invalid range ${offset}+${length} of ${end}`);

export interface ByteViewOptions {
  readonly littleEndian?: boolean;
  /** Reads end here instead of at the end of the bytes. */
  readonly end?: number;
  readonly error?: ByteRangeError;
}

/**
 * Bounds-checked random access to a byte span. Every read is checked against the view's
 * end, or against a nearer `end` passed to the read, such as the end of an enclosing record.
 * Offsets are relative to the start of `bytes`.
 */
export class ByteView {
  readonly view: DataView;
  readonly littleEndian: boolean;
  readonly end: number;
  private readonly error: ByteRangeError;
  constructor(
    readonly bytes: Uint8Array,
    options: ByteViewOptions = {},
  ) {
    this.view = byteDataView(bytes);
    this.littleEndian = options.littleEndian ?? false;
    this.error = options.error ?? invalidRange;
    this.end = options.end ?? bytes.length;
    if (!Number.isSafeInteger(this.end) || this.end < 0 || this.end > bytes.length)
      throw this.error(0, this.end, bytes.length);
  }
  /** Throws unless `length` bytes at `offset` end at or before `end`; returns `offset`. */
  check(offset: number, length: number, end = this.end): number {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      end > this.end ||
      offset > end - length
    )
      throw this.error(offset, length, Math.min(end, this.end));
    return offset;
  }
  /** The checked bytes, sharing storage. */
  range(offset: number, length: number, end?: number): Uint8Array {
    this.check(offset, length, end);
    return this.bytes.subarray(offset, offset + length);
  }
  /** A view of the checked bytes with the same endianness and errors. */
  sub(offset: number, length: number, end?: number): ByteView {
    return new ByteView(this.range(offset, length, end), {
      littleEndian: this.littleEndian,
      error: this.error,
    });
  }
  u8(offset: number, end?: number): number {
    return this.bytes[this.check(offset, 1, end)]!;
  }
  i8(offset: number, end?: number): number {
    return this.view.getInt8(this.check(offset, 1, end));
  }
  u16(offset: number, end?: number): number {
    return this.view.getUint16(this.check(offset, 2, end), this.littleEndian);
  }
  i16(offset: number, end?: number): number {
    return this.view.getInt16(this.check(offset, 2, end), this.littleEndian);
  }
  u32(offset: number, end?: number): number {
    return this.view.getUint32(this.check(offset, 4, end), this.littleEndian);
  }
  i32(offset: number, end?: number): number {
    return this.view.getInt32(this.check(offset, 4, end), this.littleEndian);
  }
  u64(offset: number, end?: number): bigint {
    return this.view.getBigUint64(this.check(offset, 8, end), this.littleEndian);
  }
  i64(offset: number, end?: number): bigint {
    return this.view.getBigInt64(this.check(offset, 8, end), this.littleEndian);
  }
  f32(offset: number, end?: number): number {
    return this.view.getFloat32(this.check(offset, 4, end), this.littleEndian);
  }
  f64(offset: number, end?: number): number {
    return this.view.getFloat64(this.check(offset, 8, end), this.littleEndian);
  }
  /**
   * Bytes of a zero-terminated string, excluding the zero. With `length` the string is a
   * field of that many bytes and ends at its first zero or at the field's end; without it a
   * zero must follow before `end`.
   */
  cString(offset: number, length?: number, end = this.end): Uint8Array {
    if (length !== undefined) {
      const field = this.range(offset, length, end),
        zero = field.indexOf(0);
      return zero < 0 ? field : field.subarray(0, zero);
    }
    this.check(offset, 1, end);
    const zero = this.bytes.subarray(offset, end).indexOf(0);
    if (zero < 0) throw this.error(offset, end - offset + 1, end);
    return this.bytes.subarray(offset, offset + zero);
  }
  /** Latin-1 characters of the checked bytes, e.g. a four-character tag. */
  ascii(offset: number, length: number, end?: number): string {
    return String.fromCharCode(...this.range(offset, length, end));
  }
}

/** A cursor over a ByteView: each read advances `position` past the bytes it consumed. */
export class BinaryReader {
  readonly data: ByteView;
  position = 0;
  constructor(bytes: Uint8Array, littleEndian = false) {
    this.data = new ByteView(bytes, {littleEndian});
  }
  get bytes(): Uint8Array {
    return this.data.bytes;
  }
  get littleEndian(): boolean {
    return this.data.littleEndian;
  }
  /** Consumes `length` bytes and returns their offset. */
  take(length: number): number {
    const p = this.data.check(this.position, length);
    this.position += length;
    return p;
  }
  skip(length: number): void {
    this.take(length);
  }
  range(length: number): Uint8Array {
    return this.data.range(this.take(length), length);
  }
  u8(): number {
    return this.data.u8(this.take(1));
  }
  i8(): number {
    return this.data.i8(this.take(1));
  }
  u16(): number {
    return this.data.u16(this.take(2));
  }
  i16(): number {
    return this.data.i16(this.take(2));
  }
  u32(): number {
    return this.data.u32(this.take(4));
  }
  i32(): number {
    return this.data.i32(this.take(4));
  }
  u64(): bigint {
    return this.data.u64(this.take(8));
  }
  i64(): bigint {
    return this.data.i64(this.take(8));
  }
  f32(): number {
    return this.data.f32(this.take(4));
  }
  f64(): number {
    return this.data.f64(this.take(8));
  }
}
