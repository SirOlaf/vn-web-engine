import {ascii, checkRange} from '../../core/binary.js';
export interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  pixels: Uint8Array;
  /** Source palette indices, preserved before RGBA expansion for indexed images. */
  indices?: Uint8Array;
}
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function pngCrc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
/** PNG scanline decoding; the platform supplies only the zlib/DEFLATE primitive.
 * No browser color-management or alpha premultiplication is applied to stored samples. */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  if (!signature.every((b, i) => bytes[i] === b)) throw new Error('Expected PNG signature');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    idat: Uint8Array[] = [];
  let width = 0,
    height = 0,
    depth = 0,
    type = -1,
    interlace = 0,
    palette: Uint8Array | undefined,
    alpha: Uint8Array | undefined,
    end = false,
    sawData = false,
    closedData = false;
  for (let pos = 8; pos < bytes.length;) {
    checkRange(bytes.length, pos, 12);
    const size = v.getUint32(pos),
      tag = ascii(bytes, pos + 4, 4);
    checkRange(bytes.length, pos + 8, size + 4);
    if (pngCrc(bytes.subarray(pos + 4, pos + 8 + size)) !== v.getUint32(pos + 8 + size))
      throw new Error(`PNG ${tag} CRC mismatch`);
    const data = bytes.subarray(pos + 8, pos + 8 + size),
      d = new DataView(data.buffer, data.byteOffset, data.length);
    if (type === -1 && tag !== 'IHDR') throw new Error('PNG IHDR must be first');
    if (tag === 'IHDR') {
      if (type !== -1 || size !== 13) throw new Error('Invalid PNG IHDR');
      width = d.getUint32(0);
      height = d.getUint32(4);
      depth = data[8]!;
      type = data[9]!;
      interlace = data[12]!;
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !width ||
        !height ||
        width * height > 67108864 ||
        !depths[type]?.includes(depth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        interlace > 1
      )
        throw new Error('Invalid/oversized PNG image');
    } else if (tag === 'PLTE') {
      if (sawData || palette || !size || size % 3 || size > 768 || type === 0 || type === 4)
        throw new Error('Invalid PNG palette');
      palette = data;
    } else if (tag === 'tRNS') {
      if (
        sawData ||
        alpha ||
        ![0, 2, 3].includes(type) ||
        (type === 0 && size !== 2) ||
        (type === 2 && size !== 6) ||
        (type === 3 && (!palette || size > palette.length / 3))
      )
        throw new Error('Invalid PNG transparency');
      alpha = data;
    } else if (tag === 'IDAT') {
      if (closedData || (type === 3 && !palette)) throw new Error('Invalid PNG IDAT order');
      sawData = true;
      idat.push(data);
    } else if (tag === 'IEND') {
      if (size || !sawData) throw new Error('Invalid PNG IEND');
      end = true;
      pos += 12;
      if (pos !== bytes.length) throw new Error('Trailing PNG bytes');
      break;
    } else {
      if ((bytes[pos + 4]! & 32) === 0) throw new Error(`Unsupported critical PNG chunk ${tag}`);
      if (sawData) closedData = true;
    }
    pos += 12 + size;
  }
  if (!end) throw new Error('Truncated PNG');
  const channels = ({0: 1, 2: 3, 3: 1, 4: 2, 6: 4} as Record<number, number>)[type]!;
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const layouts = passes.map((p) => {
    const [x, y, dx, dy] = p as [number, number, number, number],
      w = Math.max(0, Math.ceil((width - x) / dx)),
      h = Math.max(0, Math.ceil((height - y) / dy));
    return {x, y, dx, dy, w, h, row: Math.ceil((w * channels * depth) / 8)};
  });
  const expected = layouts.reduce((n, p) => n + (p.w && p.h ? (p.row + 1) * p.h : 0), 0),
    raw = new Uint8Array(expected);
  const stream = new Blob(idat.map((b) => Uint8Array.from(b)))
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  let filled = 0;
  try {
    for (;;) {
      const r = await stream.read();
      if (r.done) break;
      if (filled + r.value.length > expected)
        throw new Error('PNG inflated data exceeds scanlines');
      raw.set(r.value, filled);
      filled += r.value.length;
    }
  } catch (error) {
    await stream.cancel(error);
    throw error;
  } finally {
    stream.releaseLock();
  }
  if (filled !== expected) throw new Error('Truncated PNG scanlines');
  const pixels = new Uint8Array(width * height * 4),
    indices = type === 3 ? new Uint8Array(width * height) : undefined,
    bpp = Math.max(1, Math.ceil((channels * depth) / 8)),
    max = (1 << Math.min(depth, 16)) - 1;
  const transparent = alpha
    ? new DataView(alpha.buffer, alpha.byteOffset, alpha.length)
    : undefined;
  let cursor = 0;
  for (const p of layouts) {
    if (!p.w || !p.h) continue;
    let previous = new Uint8Array(p.row),
      row = new Uint8Array(p.row);
    for (let y = 0; y < p.h; y++) {
      const filter = raw[cursor++]!;
      if (filter > 4) throw new Error(`Invalid PNG filter ${filter}`);
      for (let i = 0; i < p.row; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0,
          b = previous[i]!,
          c = i >= bpp ? previous[i - bpp]! : 0;
        row[i] =
          (raw[cursor++]! +
            (filter === 0
              ? 0
              : filter === 1
                ? a
                : filter === 2
                  ? b
                  : filter === 3
                    ? (a + b) >>> 1
                    : paeth(a, b, c))) &
          255;
      }
      const sample = (index: number) =>
        depth === 16
          ? (row[index * 2]! << 8) | row[index * 2 + 1]!
          : depth === 8
            ? row[index]!
            : (row[(index * depth) >>> 3]! >>> (8 - depth - ((index * depth) & 7))) & max;
      const toByte = (n: number) => (depth === 16 ? n >>> 8 : Math.round((n * 255) / max));
      for (let x = 0; x < p.w; x++) {
        const n = x * channels,
          out = ((p.y + y * p.dy) * width + p.x + x * p.dx) * 4;
        let r = 0,
          g = 0,
          b = 0,
          a = 255;
        if (type === 3) {
          const ix = sample(n);
          indices![(p.y + y * p.dy) * width + p.x + x * p.dx] = ix;
          if (!palette || ix * 3 + 2 >= palette.length)
            throw new Error('PNG palette index out of range');
          r = palette[ix * 3]!;
          g = palette[ix * 3 + 1]!;
          b = palette[ix * 3 + 2]!;
          a = alpha?.[ix] ?? 255;
        } else if (type === 0 || type === 4) {
          const gray = sample(n);
          r = g = b = toByte(gray);
          if (type === 4) a = toByte(sample(n + 1));
          else if (transparent && gray === transparent.getUint16(0)) a = 0;
        } else {
          const sr = sample(n),
            sg = sample(n + 1),
            sb = sample(n + 2);
          r = toByte(sr);
          g = toByte(sg);
          b = toByte(sb);
          if (type === 6) a = toByte(sample(n + 3));
          else if (
            transparent &&
            sr === transparent.getUint16(0) &&
            sg === transparent.getUint16(2) &&
            sb === transparent.getUint16(4)
          )
            a = 0;
        }
        pixels[out] = r;
        pixels[out + 1] = g;
        pixels[out + 2] = b;
        pixels[out + 3] = a;
      }
      [previous, row] = [row, previous];
    }
  }
  return {width, height, colorType: type, bitDepth: depth, pixels, indices};
}
