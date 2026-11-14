/** Theora I header packets (identification 0x80, comment 0x81, setup 0x82) as specified by
 * the Theora I specification and implemented by libtheora's decoder. */

/** MSB-first bit reader. Reads past the end return zero bits, as libtheora's packet reader
 * does for frame data; header parsers check `overrun` themselves. */
export class TheoraBits {
  private position = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get overrun(): boolean {
    return this.position > this.bytes.length * 8;
  }
  get bitPosition(): number {
    return this.position;
  }
  read1(): number {
    const position = this.position++;
    const byte = this.bytes[position >>> 3];
    return byte === undefined ? 0 : (byte >>> (7 - (position & 7))) & 1;
  }
  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 2 + this.read1();
    return value;
  }
}

export type TheoraPixelFormat = 0 | 2 | 3;

export interface TheoraInfo {
  readonly version: readonly [number, number, number];
  /** Frame size in macroblocks. */
  readonly macroblockWidth: number;
  readonly macroblockHeight: number;
  /** Picture region; `pictureY` counts from the bottom of the frame, as stored. */
  readonly pictureWidth: number;
  readonly pictureHeight: number;
  readonly pictureX: number;
  readonly pictureY: number;
  readonly frameRateNumerator: number;
  readonly frameRateDenominator: number;
  readonly aspectNumerator: number;
  readonly aspectDenominator: number;
  readonly colorSpace: number;
  readonly bitrate: number;
  readonly quality: number;
  readonly keyframeGranuleShift: number;
  /** 0 = 4:2:0, 2 = 4:2:2, 3 = 4:4:4. */
  readonly pixelFormat: TheoraPixelFormat;
}

export interface TheoraSetup {
  /** Loop filter limit per qi. */
  readonly loopFilterLimits: Uint8Array;
  /** Dequantization matrices [qti][pli][qi], 64 entries in natural order. */
  readonly quantizers: readonly (readonly (readonly Uint16Array[])[])[];
  /** 80 Huffman trees: `tree[node + bit]` >= 0 is the next node index, < 0 is `-1 - token`.
   * A one-entry tree is a single token coded with zero bits. */
  readonly huffman: readonly Int16Array[];
}

const SIGNATURE = [0x74, 0x68, 0x65, 0x6f, 0x72, 0x61];

function header(bits: TheoraBits, type: number): void {
  if (bits.read(8) !== type) throw Error('Invalid Theora header type');
  for (const byte of SIGNATURE) if (bits.read(8) !== byte) throw Error('Invalid Theora signature');
}

/** Packet type of a header packet, or null for a data packet. */
export function theoraHeaderType(packet: Uint8Array): number | null {
  if (!packet.length || !(packet[0]! & 0x80)) return null;
  return packet[0]!;
}

export function parseTheoraInfo(packet: Uint8Array): TheoraInfo {
  const bits = new TheoraBits(packet);
  header(bits, 0x80);
  const version = [bits.read(8), bits.read(8), bits.read(8)] as const;
  // libtheora accepts 3.2.x and earlier minor versions of major 3.
  if (version[0] !== 3 || version[1] > 2) throw Error('Unsupported Theora version');
  const macroblockWidth = bits.read(16),
    macroblockHeight = bits.read(16);
  const pictureWidth = bits.read(24),
    pictureHeight = bits.read(24),
    pictureX = bits.read(8),
    pictureY = bits.read(8);
  const frameRateNumerator = bits.read(32),
    frameRateDenominator = bits.read(32),
    aspectNumerator = bits.read(24),
    aspectDenominator = bits.read(24),
    colorSpace = bits.read(8),
    bitrate = bits.read(24),
    quality = bits.read(6),
    keyframeGranuleShift = bits.read(5),
    pixelFormat = bits.read(2),
    reserved = bits.read(3);
  if (bits.overrun) throw Error('Truncated Theora identification header');
  if (!macroblockWidth || !macroblockHeight) throw Error('Invalid Theora frame size');
  if (
    pictureWidth + pictureX > macroblockWidth * 16 ||
    pictureHeight + pictureY > macroblockHeight * 16
  )
    throw Error('Invalid Theora picture region');
  if (!frameRateNumerator || !frameRateDenominator) throw Error('Invalid Theora frame rate');
  if (pixelFormat === 1 || reserved) throw Error('Invalid Theora pixel format');
  return {
    version,
    macroblockWidth,
    macroblockHeight,
    pictureWidth,
    pictureHeight,
    pictureX,
    pictureY,
    frameRateNumerator,
    frameRateDenominator,
    aspectNumerator,
    aspectDenominator,
    colorSpace,
    bitrate,
    quality,
    keyframeGranuleShift,
    pixelFormat: pixelFormat as TheoraPixelFormat,
  };
}

/** Validates the comment header; its vendor string and comments are not used. */
export function parseTheoraComment(packet: Uint8Array): void {
  const bits = new TheoraBits(packet);
  header(bits, 0x81);
  let offset = 7;
  const length = () => {
    if (offset + 4 > packet.length) throw Error('Truncated Theora comment header');
    const value =
      (packet[offset]! | (packet[offset + 1]! << 8) | (packet[offset + 2]! << 16)) +
      packet[offset + 3]! * 0x1000000;
    offset += 4;
    return value;
  };
  const skip = () => {
    const size = length();
    offset += size;
  };
  skip();
  for (let count = length(); count > 0; count--) skip();
  if (offset > packet.length) throw Error('Truncated Theora comment header');
}

/** Bits needed to represent `value` (ilog in the specification). */
function ilog(value: number): number {
  let bits = 0;
  while (value > 0) {
    bits++;
    value >>>= 1;
  }
  return bits;
}

export function parseTheoraSetup(packet: Uint8Array): TheoraSetup {
  const bits = new TheoraBits(packet);
  header(bits, 0x82);
  const loopFilterLimits = new Uint8Array(64);
  {
    const size = bits.read(3);
    for (let qi = 0; qi < 64; qi++) loopFilterLimits[qi] = bits.read(size);
  }
  const acScale = new Uint16Array(64),
    dcScale = new Uint16Array(64);
  for (const table of [acScale, dcScale]) {
    const size = bits.read(4) + 1;
    for (let qi = 0; qi < 64; qi++) table[qi] = bits.read(size);
  }
  const matrixCount = bits.read(9) + 1;
  const bases: Uint8Array[] = [];
  for (let index = 0; index < matrixCount; index++) {
    const matrix = new Uint8Array(64);
    for (let ci = 0; ci < 64; ci++) matrix[ci] = bits.read(8);
    bases.push(matrix);
  }
  // Quant ranges [qti][pli]: sizes and base matrix indices (sizes.length + 1 entries).
  const ranges: {sizes: number[]; matrices: number[]}[][] = [[], []];
  for (let qti = 0; qti < 2; qti++)
    for (let pli = 0; pli < 3; pli++) {
      const fresh = qti > 0 || pli > 0 ? bits.read1() : 1;
      if (!fresh) {
        const previous = qti > 0 && bits.read1() ? ranges[qti - 1]![pli]! : null;
        const source = previous ?? (pli > 0 ? ranges[qti]![pli - 1]! : ranges[qti - 1]![2]!);
        ranges[qti]![pli] = {sizes: source.sizes.slice(), matrices: source.matrices.slice()};
        continue;
      }
      const sizes: number[] = [],
        matrices = [bits.read(ilog(matrixCount - 1))];
      let qi = 0;
      while (qi < 63) {
        const size = bits.read(ilog(62 - qi)) + 1;
        qi += size;
        sizes.push(size);
        matrices.push(bits.read(ilog(matrixCount - 1)));
      }
      if (qi > 63) throw Error('Invalid Theora quant ranges');
      for (const matrix of matrices)
        if (matrix >= matrixCount) throw Error('Invalid Theora base matrix index');
      ranges[qti]![pli] = {sizes, matrices};
    }
  const huffman: Int16Array[] = [];
  for (let table = 0; table < 80; table++) huffman.push(readHuffmanTree(bits));
  if (bits.overrun) throw Error('Truncated Theora setup header');
  const quantizers = [0, 1].map((qti) =>
    [0, 1, 2].map((pli) => {
      const range = ranges[qti]![pli]!;
      const matrices: Uint16Array[] = [];
      for (let qi = 0; qi < 64; qi++)
        matrices.push(quantizer(qti, qi, range, bases, acScale, dcScale));
      return matrices;
    }),
  );
  return {loopFilterLimits, quantizers, huffman};
}

/** Specification 6.4.3: interpolate the base matrices of the quant range holding qi. */
function quantizer(
  qti: number,
  qi: number,
  range: {sizes: number[]; matrices: number[]},
  bases: Uint8Array[],
  acScale: Uint16Array,
  dcScale: Uint16Array,
): Uint16Array {
  let start = 0,
    qri = 0;
  while (qri < range.sizes.length - 1 && qi >= start + range.sizes[qri]!)
    start += range.sizes[qri++]!;
  const size = range.sizes[qri]!,
    end = start + size;
  const first = bases[range.matrices[qri]!]!,
    second = bases[range.matrices[qri + 1]!]!;
  const matrix = new Uint16Array(64);
  for (let ci = 0; ci < 64; ci++) {
    const base = Math.floor(
      (2 * (end - qi) * first[ci]! + 2 * (qi - start) * second[ci]! + size) / (2 * size),
    );
    const minimum = qti === 0 ? (ci === 0 ? 16 : 8) : ci === 0 ? 32 : 16;
    const scale = ci === 0 ? dcScale[qi]! : acScale[qi]!;
    matrix[ci] = Math.max(minimum, Math.min(Math.floor((scale * base) / 100) * 4, 4096));
  }
  return matrix;
}

/** Specification 6.4.4: a 0 bit opens two subtrees (0 then 1), a 1 bit is a leaf with a
 * 5-bit token. Codes are at most 32 bits long and a table has at most 32 tokens. */
function readHuffmanTree(bits: TheoraBits): Int16Array {
  const nodes: number[] = [];
  let leaves = 0;
  const read = (depth: number): number => {
    if (bits.overrun) throw Error('Truncated Theora Huffman table');
    if (bits.read1()) {
      if (++leaves > 32) throw Error('Invalid Theora Huffman table');
      return -1 - bits.read(5);
    }
    if (depth >= 32) throw Error('Invalid Theora Huffman table');
    const node = nodes.length;
    nodes.push(0, 0);
    const zero = read(depth + 1);
    nodes[node] = zero;
    const one = read(depth + 1);
    nodes[node + 1] = one;
    return node;
  };
  const root = read(0);
  // A single-leaf table encodes its token with zero bits.
  if (root < 0) return Int16Array.of(root);
  return Int16Array.from(nodes);
}
