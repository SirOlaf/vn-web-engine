import {checkRange} from '../../core/binary.js';
export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
export function signature(bytes: Uint8Array, value: string, offset = 0): boolean {
  return (
    offset + value.length <= bytes.length &&
    Array.from(value).every((c, i) => bytes[offset + i] === c.charCodeAt(0))
  );
}
/** The native PRNG returns the product's high bits BEFORE the increment. */
export function randomByteGenerator(seed: number): () => number {
  return () => {
    const product = Math.imul(seed, 0x015a4e35) >>> 0;
    seed = (product + 1) >>> 0;
    return (product >>> 16) & 255;
  };
}
export class Bits {
  position = 0;
  constructor(readonly bytes: Uint8Array) {}
  read(count: number): number {
    if (count < 0 || count > 32 || this.position + count > this.bytes.length * 8)
      throw new Error('Truncated BURIKO bitstream');
    let value = 0;
    for (let i = 0; i < count; i++, this.position++)
      value = value * 2 + ((this.bytes[this.position >>> 3]! >>> (7 - (this.position & 7))) & 1);
    return value;
  }
}
export function unsignedVarint(bytes: Uint8Array, cursor: {position: number}): number {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    checkRange(bytes.length, cursor.position, 1);
    const b = bytes[cursor.position++]!;
    if (shift === 28 && b > 15) throw new Error('BURIKO varint overflow');
    value += (b & 127) * 2 ** shift;
    if (!(b & 128)) return value;
  }
  throw new Error('Invalid BURIKO varint');
}
