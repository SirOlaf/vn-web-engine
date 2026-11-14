import {ascii, checkRange} from '../../core/binary.js';
import {crc32} from '../../core/crc32.js';
export interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  pixels: Uint8Array;
  /** Source palette indices, preserved before RGBA expansion for indexed images. */
  indices?: Uint8Array;
}
export interface PngDecodeOptions {
  /** libpng consumers stop after IEND without requiring file EOF. Strict by default. */
  readonly trailingBytes?: 'reject' | 'ignore';
  /** A chunk whose CRC fails rejects the image ('reject', the default). 'discard' is libpng's
   * default CRC action (png_crc_finish): an ancillary chunk with a failed CRC is dropped with a
   * warning and decoding continues; a critical chunk still fails. */
  readonly ancillaryCrcErrors?: 'reject' | 'discard';
}
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
/** The PNG chunk CRC is CRC-32. */
export const pngCrc = crc32;
/** The Paeth predictor of PNG 9.4: of a (left), b (up) and c (up-left), the one nearest
 * a + b - c, preferring a, then b. */
function paeth(a: number, b: number, c: number): number {
  let pa = b - c,
    pb = a - c,
    pc = pa + pb;
  // Branch-free: absolute values and selections by sign masks.
  let m = pa >> 31;
  pa = (pa ^ m) - m;
  m = pb >> 31;
  pb = (pb ^ m) - m;
  m = pc >> 31;
  pc = (pc ^ m) - m;
  const notA = ((pb - pa) | (pc - pa)) >> 31,
    cOverB = (pc - pb) >> 31;
  return (a & ~notA) | (((b & ~cOverB) | (c & cOverB)) & notA);
}
/** Reverse one scanline filter into `row`; bytes left of the first pixel read as zero. */
function unfilter(
  filter: number,
  raw: Uint8Array,
  start: number,
  row: Uint8Array,
  previous: Uint8Array,
  bpp: number,
): void {
  const length = row.length,
    head = Math.min(bpp, length);
  if (filter === 0) row.set(raw.subarray(start, start + length));
  else if (filter === 1) {
    for (let i = 0; i < head; i++) row[i] = raw[start + i]!;
    for (let i = head; i < length; i++) row[i] = (raw[start + i]! + row[i - bpp]!) & 255;
  } else if (filter === 2)
    for (let i = 0; i < length; i++) row[i] = (raw[start + i]! + previous[i]!) & 255;
  else if (filter === 3) {
    for (let i = 0; i < head; i++) row[i] = (raw[start + i]! + (previous[i]! >>> 1)) & 255;
    for (let i = head; i < length; i++)
      row[i] = (raw[start + i]! + ((row[i - bpp]! + previous[i]!) >>> 1)) & 255;
  } else {
    // Paeth with a = c = 0 selects b.
    for (let i = 0; i < head; i++) row[i] = (raw[start + i]! + previous[i]!) & 255;
    for (let i = head; i < length; i++) {
      // paeth(a, b, c), with p - a = b - c, p - b = a - c and p - c = a + b - 2c.
      const a = row[i - bpp]!,
        b = previous[i]!,
        c = previous[i - bpp]!,
        pa = Math.abs(b - c),
        pb = Math.abs(a - c),
        pc = Math.abs(a + b - 2 * c);
      row[i] = (raw[start + i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
}
/** Whether a 32-bit word holds its bytes lowest first, so an RGBA pixel's alpha is the top byte. */
const littleEndian = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
/** Bytewise sums of two packed words; no carry crosses a byte. */
const add8 = (x: number, y: number) =>
  (((x & 0x7f7f7f7f) + (y & 0x7f7f7f7f)) | 0) ^ ((x ^ y) & 0x80808080);
/** Bytewise floor((x + y) / 2) of two packed words. */
const average8 = (x: number, y: number) => ((x & y) + (((x ^ y) >>> 1) & 0x7f7f7f7f)) | 0;
/**
 * Reverses one non-interlaced 8-bit RGB (`channels` 3) or RGBA scanline straight into its
 * row of RGBA `pixels`, which starts at pixel `out`; `up` is the row above, or -1 for the
 * first row. The row is copied (RGB with opaque alpha) and unfiltered in place: Sub, Up and
 * Average on whole pixels as packed little-endian words, Paeth per sample. An RGB alpha
 * byte enters only its own byte of each sum and is forced back to opaque.
 */
function unfilterPixels(
  filter: number,
  raw: Uint8Array,
  start: number,
  channels: number,
  pixels: Uint8Array,
  words: Int32Array,
  out: number,
  up: number,
  width: number,
): void {
  const opaque = channels === 3 ? 0xff000000 | 0 : 0,
    end = out + width;
  if (channels === 4) pixels.set(raw.subarray(start, start + width * 4), out * 4);
  else
    for (let w = out, s = start; w < end; w++, s += 3)
      words[w] = raw[s]! | (raw[s + 1]! << 8) | (raw[s + 2]! << 16) | opaque;
  if (filter === 4 && up < 0) filter = 1; // Paeth with b = c = 0 selects a.
  if (filter === 1)
    for (let w = out + 1; w < end; w++) words[w] = add8(words[w]!, words[w - 1]!) | opaque;
  else if (filter === 2) {
    if (up >= 0)
      for (let w = out, u = up; w < end; w++, u++) words[w] = add8(words[w]!, words[u]!) | opaque;
  } else if (filter === 3) {
    let left = 0;
    for (let w = out, u = up; w < end; w++, u++)
      words[w] = left = add8(words[w]!, average8(left, up < 0 ? 0 : words[u]!)) | opaque;
  } else if (filter === 4) {
    let a0 = 0,
      a1 = 0,
      a2 = 0,
      a3 = 0,
      c0 = 0,
      c1 = 0,
      c2 = 0,
      c3 = 0;
    for (let i = out * 4, j = up * 4, n = end * 4; i < n; i += 4, j += 4) {
      const b0 = pixels[j]!,
        b1 = pixels[j + 1]!,
        b2 = pixels[j + 2]!;
      pixels[i] = a0 = (pixels[i]! + paeth(a0, b0, c0)) & 255;
      pixels[i + 1] = a1 = (pixels[i + 1]! + paeth(a1, b1, c1)) & 255;
      pixels[i + 2] = a2 = (pixels[i + 2]! + paeth(a2, b2, c2)) & 255;
      c0 = b0;
      c1 = b1;
      c2 = b2;
      if (channels === 4) {
        const b3 = pixels[j + 3]!;
        pixels[i + 3] = a3 = (pixels[i + 3]! + paeth(a3, b3, c3)) & 255;
        c3 = b3;
      }
    }
  }
}
/** PNG scanline decoding; the platform supplies only the zlib/DEFLATE primitive.
 * No browser color-management or alpha premultiplication is applied to stored samples. */
export async function decodePng(
  bytes: Uint8Array,
  options: PngDecodeOptions = {},
): Promise<DecodedPng> {
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
    if (pngCrc(bytes.subarray(pos + 4, pos + 8 + size)) !== v.getUint32(pos + 8 + size)) {
      const ancillary = (bytes[pos + 4]! & 32) !== 0;
      if (!ancillary || options.ancillaryCrcErrors !== 'discard' || type === -1)
        throw new Error(`PNG ${tag} CRC mismatch`);
      if (sawData) closedData = true;
      pos += 12 + size;
      continue;
    }
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
      if (pos !== bytes.length && options.trailingBytes !== 'ignore')
        throw new Error('Trailing PNG bytes');
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
  if (littleEndian && !interlace && depth === 8 && (type === 6 || (type === 2 && !transparent))) {
    const words = new Int32Array(pixels.buffer, pixels.byteOffset, width * height),
      stride = width * channels;
    for (let y = 0; y < height; y++) {
      const filter = raw[cursor++]!;
      if (filter > 4) throw new Error(`Invalid PNG filter ${filter}`);
      unfilterPixels(
        filter,
        raw,
        cursor,
        channels,
        pixels,
        words,
        y * width,
        y ? (y - 1) * width : -1,
        width,
      );
      cursor += stride;
    }
    return {width, height, colorType: type, bitDepth: depth, pixels, indices};
  }
  for (const p of layouts) {
    if (!p.w || !p.h) continue;
    let previous = new Uint8Array(p.row),
      row = new Uint8Array(p.row);
    for (let y = 0; y < p.h; y++) {
      const filter = raw[cursor++]!;
      if (filter > 4) throw new Error(`Invalid PNG filter ${filter}`);
      unfilter(filter, raw, cursor, row, previous, bpp);
      cursor += p.row;
      if (depth === 8 && (type === 4 || (type === 0 && !transparent))) {
        // Direct 8-bit gray rows: toByte is the identity for 8-bit samples.
        const out = (p.y + y * p.dy) * width * 4;
        for (let x = 0, n = 0; x < p.w; x++, n += channels) {
          const o = out + (p.x + x * p.dx) * 4,
            gray = row[n]!;
          pixels[o] = gray;
          pixels[o + 1] = gray;
          pixels[o + 2] = gray;
          pixels[o + 3] = type === 4 ? row[n + 1]! : 255;
        }
        [previous, row] = [row, previous];
        continue;
      }
      if (depth === 8 && (type === 6 || (type === 2 && !transparent))) {
        // Direct 8-bit truecolor rows: the generic expansion below is the identity per sample.
        const out = (p.y + y * p.dy) * width * 4;
        if (type === 6 && p.dx === 1) pixels.set(row, out);
        else
          for (let x = 0, n = 0; x < p.w; x++, n += channels) {
            const o = out + (p.x + x * p.dx) * 4;
            pixels[o] = row[n]!;
            pixels[o + 1] = row[n + 1]!;
            pixels[o + 2] = row[n + 2]!;
            pixels[o + 3] = type === 6 ? row[n + 3]! : 255;
          }
        [previous, row] = [row, previous];
        continue;
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
