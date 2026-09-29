import {checkRange} from './binary.js';
/** MSB-first bounded reader. Peeking never changes position (short codes need lookahead). */
export class BitReader {
  position = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly bitLength = bytes.length * 8,
  ) {
    checkRange(bytes.length * 8, 0, bitLength);
  }
  peek(width: number): number {
    if (!Number.isInteger(width) || width < 0 || width > 24) throw new Error('Invalid bit width');
    checkRange(this.bitLength, this.position, width);
    let p = this.position,
      left = width,
      value = 0;
    while (left) {
      const take = Math.min(left, 8 - (p & 7));
      value =
        value * 2 ** take + ((this.bytes[p >>> 3]! >>> (8 - (p & 7) - take)) & ((1 << take) - 1));
      p += take;
      left -= take;
    }
    return value;
  }
  /** `read(1)` without the general width handling; used bit-by-bit by prefix-code walks. */
  readBit(): number {
    const p = this.position;
    if (p >= this.bitLength) checkRange(this.bitLength, p, 1);
    this.position = p + 1;
    return (this.bytes[p >>> 3]! >>> (7 - (p & 7))) & 1;
  }
  read(width: number): number {
    const value = this.peek(width);
    this.position += width;
    return value;
  }
  skip(width: number): void {
    checkRange(this.bitLength, this.position, width);
    this.position += width;
  }
}
