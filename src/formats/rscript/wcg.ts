import {byteDataView, ByteView} from '../../core/binary.js';
import {BitReader} from '../../core/bits.js';

/**
 * Decoded codeX RScript image. `pixels` keeps the native 32-bit layout: bytes are
 * B, G, R and a transparency byte (0 = opaque, 255 = invisible). The engine's
 * blenders consume that byte directly, so it is not converted to alpha here.
 */
export interface RScriptImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface WcgHeader {
  readonly flags: number;
  readonly width: number;
  readonly height: number;
}

const WCG_SIGNATURE = 0x4757; // "WG"

export function readWcgHeader(bytes: Uint8Array): WcgHeader {
  if (bytes.length < 16) throw new Error('Truncated WCG image');
  const view = new ByteView(bytes, {littleEndian: true});
  if (view.u16(0) !== WCG_SIGNATURE) throw new Error('Not a WCG image');
  const flags = view.u16(2);
  const width = view.u32(8);
  const height = view.u32(12);
  if (width < 1 || height < 1 || width * height > 0x4000000)
    throw new Error(`Invalid WCG dimensions ${width}x${height}`);
  return {flags, width, height};
}

/**
 * Palette-index prefix code (0x43D5F0, 0x43E780, 0x43EA60): prefix 1 reads one bit;
 * prefixes below `escape` read `prefix - 1` bits under an implicit leading one; the
 * escape prefix adds one extra bit per leading `1`, bounded by `extensions`.
 */
function readIndex(bits: BitReader, prefix: number, escape: number, extensions: number): number {
  if (prefix === 1) return bits.readBit();
  let width = prefix - 1;
  if (prefix === escape) {
    let extra = 0;
    while (bits.readBit()) if (++extra > extensions) throw new Error('Invalid WCG escape code');
    width += extra;
  }
  return bits.read(width) + 2 ** width;
}

/** Decodes one plane into `pixels`, writing one byte or one 16-bit word every 4 bytes. */
function decodePlane(
  view: ByteView,
  cursor: number,
  pixels: Uint8Array,
  start: number,
  wide: boolean,
): number {
  view.check(cursor, 12);
  const packed = view.u32(cursor + 4);
  const entries = view.u16(cursor + 8);
  cursor += 12;
  const table = new Uint16Array(entries);
  for (let i = 0; i < entries; i++)
    table[i] = wide ? view.u16(cursor + i * 2) : view.u8(cursor + i);
  cursor += entries * (wide ? 2 : 1);
  // MSB first, as 0x43EDB0 reads; reads fail instead of padding past the end.
  const bits = new BitReader(view.range(cursor, packed));
  // 16-bit planes with large palettes use four-bit prefixes (0x43E130).
  const prefixBits = wide && entries > 0x1000 ? 4 : 3;
  const escape = prefixBits === 4 ? 15 : 7;
  const extensions = !wide || prefixBits === 4 ? 1 : 5;
  const end = pixels.length;
  let position = start;
  const write = (value: number): void => {
    if (position >= end) throw new Error('WCG run overflows image');
    pixels[position] = value;
    if (wide) pixels[position + 1] = value >>> 8;
    position += 4;
  };
  while (position < end) {
    let prefix = bits.read(prefixBits);
    let run = 1;
    if (!prefix) {
      run = bits.read(4) + 2;
      prefix = bits.read(prefixBits);
    }
    const index = readIndex(bits, prefix, escape, extensions);
    if (index >= entries) throw new Error('WCG palette index out of range');
    const value = table[index]!;
    for (let i = 0; i < run; i++) write(value);
  }
  return cursor + packed;
}

/**
 * WCG image decoder (0x43BD30/0x43BE00). Version 1 images store either four byte
 * planes (transparency first) or, when `flags & 0x1C0 == 0x40`, two interleaved
 * 16-bit planes holding the high (R, transparency) and low (B, G) halves.
 */
export function decodeWcg(bytes: Uint8Array): RScriptImage {
  const {flags, width, height} = readWcgHeader(bytes);
  if ((flags & 0xf) !== 1) throw new Error(`Unsupported WCG version ${flags & 0xf}`);
  const pixels = new Uint8Array(width * height * 4);
  const view = new ByteView(bytes, {littleEndian: true});
  let cursor = 16;
  if ((flags & 0x1c0) === 0x40) {
    cursor = decodePlane(view, cursor, pixels, 2, true);
    decodePlane(view, cursor, pixels, 0, true);
  } else {
    cursor = decodePlane(view, cursor, pixels, 3, false);
    // Without flag 0x10 the native decoder fills only transparency.
    if (flags & 0x10)
      for (const channel of [2, 1, 0]) cursor = decodePlane(view, cursor, pixels, channel, false);
  }
  return {width, height, pixels};
}

/** MSB-first writer for the WCG bitstream. */
class WcgBitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private used = 0;
  write(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit--) {
      this.current = (this.current << 1) | (Math.floor(value / 2 ** bit) & 1);
      if (++this.used === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.used = 0;
      }
    }
  }
  finish(): Uint8Array {
    if (this.used) this.bytes.push(this.current << (8 - this.used));
    return Uint8Array.from(this.bytes);
  }
}

/** Encodes one 16-bit plane taken every 4 bytes from `start`, the inverse of `decodePlane`. */
function encodeWidePlane(pixels: Uint8Array, start: number): Uint8Array {
  const values: number[] = [];
  for (let i = start; i < pixels.length; i += 4) values.push(pixels[i]! | (pixels[i + 1]! << 8));
  // Frequent values get the short indexes.
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const table = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (table.length > 0xffff) throw new Error('WCG plane has too many distinct values');
  const index = new Map(table.map((value, i) => [value, i]));
  const prefixBits = table.length > 0x1000 ? 4 : 3;
  const escape = prefixBits === 4 ? 15 : 7;
  const bits = new WcgBitWriter();
  const writeIndex = (i: number): void => {
    if (i < 2) {
      bits.write(1, prefixBits);
      bits.write(i, 1);
      return;
    }
    const width = Math.floor(Math.log2(i));
    if (width + 1 < escape) bits.write(width + 1, prefixBits);
    else {
      bits.write(escape, prefixBits);
      for (let extra = width - (escape - 1); extra > 0; extra--) bits.write(1, 1);
      bits.write(0, 1);
    }
    bits.write(i - 2 ** width, width);
  };
  for (let i = 0; i < values.length;) {
    let run = 1;
    while (run < 17 && values[i + run] === values[i]) run++;
    if (run >= 2) {
      bits.write(0, prefixBits);
      bits.write(run - 2, 4);
    } else run = 1;
    writeIndex(index.get(values[i]!)!);
    i += run;
  }
  const packed = bits.finish();
  const plane = new Uint8Array(12 + table.length * 2 + packed.length);
  const view = byteDataView(plane);
  view.setUint32(0, values.length, true);
  view.setUint32(4, packed.length, true);
  view.setUint16(8, table.length, true);
  table.forEach((value, i) => view.setUint16(12 + i * 2, value, true));
  plane.set(packed, 12 + table.length * 2);
  return plane;
}

/**
 * Encodes an image as a version 1 WCG with two 16-bit planes, the form the native
 * save-thumbnail writer produces (0x436C00, flags 0x271).
 */
export function encodeWcg(image: RScriptImage): Uint8Array {
  const {width, height, pixels} = image;
  if (pixels.length !== width * height * 4)
    throw new Error('WCG pixel data does not match its size');
  const high = encodeWidePlane(pixels, 2),
    low = encodeWidePlane(pixels, 0);
  const bytes = new Uint8Array(16 + high.length + low.length);
  const view = byteDataView(bytes);
  view.setUint16(0, WCG_SIGNATURE, true);
  view.setUint16(2, 0x271, true);
  view.setUint16(4, 32, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  bytes.set(high, 16);
  bytes.set(low, 16 + high.length);
  return bytes;
}
