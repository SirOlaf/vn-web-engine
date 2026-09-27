import {byteDataView, checkRange} from '../../core/binary.js';

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
  const view = byteDataView(bytes);
  if (view.getUint16(0, true) !== WCG_SIGNATURE) throw new Error('Not a WCG image');
  const flags = view.getUint16(2, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  if (width < 1 || height < 1 || width * height > 0x4000000)
    throw new Error(`Invalid WCG dimensions ${width}x${height}`);
  return {flags, width, height};
}

/** MSB-first reader matching 0x43EDB0: reads fail instead of padding past the end. */
class WcgBits {
  private position = 0;
  private remaining = 8;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    private readonly end: number,
  ) {
    this.position = start;
  }
  read(count: number): number {
    let value = 0;
    while (count) {
      if (this.position >= this.end) throw new Error('Truncated WCG bitstream');
      const available = this.remaining;
      const byte = this.bytes[this.position]! & ((1 << available) - 1);
      if (available <= count) {
        count -= available;
        value += byte * 2 ** count;
        this.position++;
        this.remaining = 8;
      } else {
        this.remaining = available - count;
        value += byte >>> this.remaining;
        count = 0;
      }
    }
    return value;
  }
}

/**
 * Palette-index prefix code (0x43D5F0, 0x43E780, 0x43EA60): prefix 1 reads one bit;
 * prefixes below `escape` read `prefix - 1` bits under an implicit leading one; the
 * escape prefix adds one extra bit per leading `1`, bounded by `extensions`.
 */
function readIndex(bits: WcgBits, prefix: number, escape: number, extensions: number): number {
  if (prefix === 1) return bits.read(1);
  let width = prefix - 1;
  if (prefix === escape) {
    let extra = 0;
    while (bits.read(1)) if (++extra > extensions) throw new Error('Invalid WCG escape code');
    width += extra;
  }
  return bits.read(width) + 2 ** width;
}

/** Decodes one plane into `pixels`, writing one byte or one 16-bit word every 4 bytes. */
function decodePlane(
  bytes: Uint8Array,
  cursor: number,
  pixels: Uint8Array,
  start: number,
  wide: boolean,
): number {
  checkRange(bytes.length, cursor, 12);
  const view = byteDataView(bytes);
  const packed = view.getUint32(cursor + 4, true);
  const entries = view.getUint16(cursor + 8, true);
  cursor += 12;
  const tableSize = entries * (wide ? 2 : 1);
  checkRange(bytes.length, cursor, tableSize);
  const table = new Uint16Array(entries);
  for (let i = 0; i < entries; i++)
    table[i] = wide ? view.getUint16(cursor + i * 2, true) : bytes[cursor + i]!;
  cursor += tableSize;
  checkRange(bytes.length, cursor, packed);
  const bits = new WcgBits(bytes, cursor, cursor + packed);
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
  let cursor = 16;
  if ((flags & 0x1c0) === 0x40) {
    cursor = decodePlane(bytes, cursor, pixels, 2, true);
    decodePlane(bytes, cursor, pixels, 0, true);
  } else {
    cursor = decodePlane(bytes, cursor, pixels, 3, false);
    // Without flag 0x10 the native decoder fills only transparency.
    if (flags & 0x10)
      for (const channel of [2, 1, 0]) cursor = decodePlane(bytes, cursor, pixels, channel, false);
  }
  return {width, height, pixels};
}
