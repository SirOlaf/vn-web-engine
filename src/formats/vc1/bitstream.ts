// Derived from FFmpeg 7.1.1; LGPL-2.1-or-later. See NOTICE and LICENSE.
/** Bytes after the end of every buffer a `BitReader` reads; reads past the end see zeros. */
export const BITSTREAM_PADDING = 64;

/** MSB-first bit reader with the bounds behaviour of FFmpeg's checked `GetBitContext`: the
 * position stops 8 bits past the end, and bits past the end read as zero. The buffer must
 * have `BITSTREAM_PADDING` zero bytes after `size` bytes. */
export class BitReader {
  /** Bit position. */
  index = 0;
  sizeInBits = 0;
  private limit = 8;
  constructor(
    public buffer: Uint8Array = new Uint8Array(BITSTREAM_PADDING),
    bytes = 0,
  ) {
    this.reset(buffer, bytes * 8);
  }

  reset(buffer: Uint8Array, bits: number): void {
    this.buffer = buffer;
    this.index = 0;
    this.sizeInBits = bits;
    this.limit = bits + 8;
  }

  /** Next `n` bits (1–25) without consuming them. */
  show(n: number): number {
    const b = this.buffer,
      p = this.index >> 3;
    const word =
      ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) << (this.index & 7);
    return word >>> (32 - n);
  }

  skip(n: number): void {
    const next = this.index + n;
    this.index = next < this.limit ? next : this.limit;
  }

  /** `n` bits (1–25). */
  bits(n: number): number {
    const value = this.show(n);
    this.skip(n);
    return value;
  }

  bit(): number {
    const i = this.index,
      value = (this.buffer[i >> 3]! << (i & 7)) & 0x80;
    if (i < this.limit) this.index = i + 1;
    return value >> 7;
  }

  /** `n` bits (0–32). */
  bitsLong(n: number): number {
    if (!n) return 0;
    if (n <= 25) return this.bits(n);
    const high = this.bits(16);
    return ((high << (n - 16)) | this.bits(n - 16)) >>> 0;
  }

  left(): number {
    return this.sizeInBits - this.index;
  }

  /** 0, 1 or 2 coded as 0, 10, 11. */
  decode012(): number {
    return this.bit() ? this.bit() + 1 : 0;
  }

  /** 0, 1 or 2 coded as 1, 01, 00. */
  decode210(): number {
    return this.bit() ? 0 : 2 - this.bit();
  }

  /** Counts bits until `stop` or `len` bits. */
  unary(stop: number, len: number): number {
    let i = 0;
    while (i < len && this.bit() !== stop) i++;
    return i;
  }

  /** FFmpeg `get_vlc2`: a symbol from `table` (root `bits` wide, at most `depth` levels);
   * -1 for an invalid code. */
  vlc(table: Vlc, bits: number, depth: number): number {
    const sym = table.sym,
      len = table.len;
    let index = this.show(bits),
      code = sym[index]!,
      n = len[index]!;
    if (depth > 1 && n < 0) {
      this.skip(bits);
      let nb = -n;
      index = this.show(nb) + code;
      code = sym[index]!;
      n = len[index]!;
      if (depth > 2 && n < 0) {
        this.skip(nb);
        nb = -n;
        index = this.show(nb) + code;
        code = sym[index]!;
        n = len[index]!;
      }
    }
    this.skip(n);
    return code;
  }
}

/** A multi-level VLC lookup table in FFmpeg's layout: an entry with a negative length links
 * to a subtable of that many bits at index `sym`. */
export interface Vlc {
  readonly sym: Int16Array;
  readonly len: Int16Array;
}

/** FFmpeg `ff_vlc_init_sparse` without symbols (symbol = code index): builds the table for
 * `count` codes taken from `source` as (code, length) pairs starting at pair `first`. */
export function buildVlc(
  bits: number,
  source: ArrayLike<number>,
  first: number,
  count: number,
): Vlc {
  const codes: {bits: number; code: number; symbol: number}[] = [];
  const copy = (long: boolean) => {
    for (let i = 0; i < count; i++) {
      const code = source[(first + i) * 2]!,
        length = source[(first + i) * 2 + 1]!;
      if (long ? !(length > bits) : !(length && length <= bits)) continue;
      if (length > 3 * bits || length > 32 || code >= 2 ** length) throw Error('Invalid VLC table');
      codes.push({bits: length, code: (code * 2 ** (32 - length)) >>> 0, symbol: i});
    }
  };
  copy(true);
  codes.sort((a, b) => (a.code >>> 1) - (b.code >>> 1));
  copy(false);
  const sym: number[] = [],
    len: number[] = [];
  const build = (tableBits: number, list: typeof codes, start: number, end: number): number => {
    const size = 1 << tableBits,
      base = sym.length;
    for (let i = 0; i < size; i++) (sym.push(0), len.push(0));
    for (let i = start; i < end; i++) {
      let n = list[i]!.bits;
      const code = list[i]!.code,
        symbol = list[i]!.symbol;
      if (n <= tableBits) {
        let j = code >>> (32 - tableBits);
        const nb = 1 << (tableBits - n);
        for (let k = 0; k < nb; k++, j++) {
          if ((len[base + j] || sym[base + j]) && (len[base + j] !== n || sym[base + j] !== symbol))
            throw Error('Invalid VLC table');
          len[base + j] = n;
          sym[base + j] = symbol;
        }
      } else {
        n -= tableBits;
        const prefix = code >>> (32 - tableBits);
        let subBits = n,
          k = i + 1;
        list[i] = {bits: n, code: (code << tableBits) >>> 0, symbol};
        for (; k < end; k++) {
          const m = list[k]!.bits - tableBits;
          if (m <= 0) break;
          const c = list[k]!.code;
          if (c >>> (32 - tableBits) !== prefix) break;
          list[k] = {bits: m, code: (c << tableBits) >>> 0, symbol: list[k]!.symbol};
          subBits = Math.max(subBits, m);
        }
        subBits = Math.min(subBits, tableBits);
        len[base + prefix] = -subBits;
        sym[base + prefix] = build(subBits, list, i, k);
        i = k - 1;
      }
    }
    for (let i = 0; i < size; i++) if (len[base + i] === 0) sym[base + i] = -1;
    return base;
  };
  build(bits, codes, 0, codes.length);
  return {sym: Int16Array.from(sym), len: Int16Array.from(len)};
}
