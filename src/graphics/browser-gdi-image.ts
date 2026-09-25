import {decodePng, pngCrc} from '../formats/png/decode.js';
import {decodeBrowserImage} from './browser-image.js';
import type {
  WindowsGdiDecodedBitmap,
  WindowsGdiEncoder,
  WindowsGdiImageCodecHost,
  WindowsGdiLockedBitmap,
  WindowsGdiScan0Bitmap,
} from '../platform/windows-gdi-image.js';

const indexed = 0x30803,
  rgb24 = 0x21808,
  argb32 = 0x26200a,
  rgb32 = 0x22009;
const encoders: readonly WindowsGdiEncoder[] = [
  {mime: 'image/bmp', id: 'browser-bmp'},
  {mime: 'image/jpeg', id: 'browser-jpeg'},
  {mime: 'image/gif', id: 'browser-gif'},
  {mime: 'image/tiff', id: 'browser-tiff'},
  {mime: 'image/png', id: 'browser-png'},
];

interface Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
  pixelFormat: number;
  indices?: Uint8Array;
}

function checkedRaster(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 0x4000000
  )
    throw new RangeError('GDI image dimensions exceed browser raster storage');
}

function bmp(bytes: Uint8Array): Raster {
  if (bytes.length < 54 || bytes[0] !== 66 || bytes[1] !== 77)
    throw new Error('Invalid BMP header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = v.getUint32(14, true);
  if (header < 40 || 14 + header > bytes.length || v.getUint16(26, true) !== 1)
    throw new Error('Unsupported BMP information header');
  const width = v.getInt32(18, true),
    signedHeight = v.getInt32(22, true);
  const height = Math.abs(signedHeight),
    depth = v.getUint16(28, true);
  checkedRaster(width, height);
  if (![8, 24, 32].includes(depth) || v.getUint32(30, true) !== 0)
    throw new Error('Unsupported BMP pixel format or compression');
  const offset = v.getUint32(10, true);
  const stride = Math.floor((width * depth + 31) / 32) * 4;
  if (offset + stride * height > bytes.length) throw new Error('Truncated BMP pixels');
  const colors = depth === 8 ? v.getUint32(46, true) || 256 : 0;
  if (colors > 256 || 14 + header + colors * 4 > offset) throw new Error('Invalid BMP palette');
  const rgba = new Uint8Array(width * height * 4);
  const indices = depth === 8 ? new Uint8Array(width * height) : undefined;
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (depth === 8) {
        const index = bytes[row + x]!;
        if (index >= colors) throw new Error('BMP palette index outside color table');
        indices![y * width + x] = index;
        const color = 14 + header + index * 4;
        rgba[out] = bytes[color + 2]!;
        rgba[out + 1] = bytes[color + 1]!;
        rgba[out + 2] = bytes[color]!;
        rgba[out + 3] = 255;
      } else {
        const pixel = row + x * (depth >>> 3);
        rgba[out] = bytes[pixel + 2]!;
        rgba[out + 1] = bytes[pixel + 1]!;
        rgba[out + 2] = bytes[pixel]!;
        // BI_RGB's high byte is unused for the GDI+ 32RGB source format.
        rgba[out + 3] = 255;
      }
    }
  }
  return {
    width,
    height,
    rgba,
    indices,
    pixelFormat: depth === 8 ? indexed : depth === 24 ? rgb24 : rgb32,
  };
}

/** First GIF image only, matching BitmapFromFile's initial active frame. */
function gif(bytes: Uint8Array): Raster {
  if (bytes.length < 13 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF')
    throw new Error('Invalid GIF header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint16(6, true),
    height = v.getUint16(8, true);
  checkedRaster(width, height);
  let at = 13;
  const globalSize = bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0;
  const global = bytes.subarray(at, at + globalSize);
  at += globalSize;
  let transparent = -1;
  while (at < bytes.length) {
    const marker = bytes[at++]!;
    if (marker === 0x21) {
      const label = bytes[at++]!;
      if (label === 0xf9 && bytes[at] === 4) {
        transparent = bytes[at + 1]! & 1 ? bytes[at + 4]! : -1;
      }
      while (at < bytes.length) {
        const size = bytes[at++]!;
        if (size === 0) break;
        at += size;
      }
      continue;
    }
    if (marker !== 0x2c || at + 9 > bytes.length) break;
    const x0 = v.getUint16(at, true),
      y0 = v.getUint16(at + 2, true),
      w = v.getUint16(at + 4, true),
      h = v.getUint16(at + 6, true),
      flags = bytes[at + 8]!;
    at += 9;
    if (!w || !h || x0 + w > width || y0 + h > height)
      throw new Error('GIF image rectangle exceeds logical screen');
    let palette = global;
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1));
      palette = bytes.subarray(at, at + size);
      at += size;
    }
    if (palette.length === 0) throw new Error('GIF image has no color table');
    const minCodeSize = bytes[at++]!;
    if (minCodeSize < 2 || minCodeSize > 8) throw new Error('Invalid GIF LZW code size');
    const parts: Uint8Array[] = [];
    let length = 0;
    while (at < bytes.length) {
      const size = bytes[at++]!;
      if (size === 0) break;
      if (at + size > bytes.length) throw new Error('Truncated GIF image data');
      parts.push(bytes.subarray(at, at + size));
      length += size;
      at += size;
    }
    const stream = new Uint8Array(length);
    for (let pos = 0, i = 0; i < parts.length; i++) {
      stream.set(parts[i]!, pos);
      pos += parts[i]!.length;
    }
    const clear = 1 << minCodeSize,
      end = clear + 1;
    let codeSize = minCodeSize + 1,
      next = end + 1,
      bit = 0;
    let dictionary: number[][] = [];
    const reset = () => {
      dictionary = Array.from({length: clear}, (_, i) => [i]);
      dictionary[clear] = [];
      dictionary[end] = [];
      codeSize = minCodeSize + 1;
      next = end + 1;
    };
    reset();
    const decoded: number[] = [];
    let previous: number[] | null = null;
    for (;;) {
      if (bit + codeSize > stream.length * 8) throw new Error('Truncated GIF LZW stream');
      let code = 0;
      for (let i = 0; i < codeSize; i++)
        code |= ((stream[(bit + i) >>> 3]! >>> ((bit + i) & 7)) & 1) << i;
      bit += codeSize;
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      if (code === end) break;
      const entry: number[] | null =
        dictionary[code] ?? (code === next && previous ? [...previous, previous[0]!] : null);
      if (entry === null) throw new Error('Invalid GIF LZW dictionary reference');
      decoded.push(...entry);
      if (previous && next < 4096) {
        dictionary[next++] = [...previous, entry[0]!];
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
      previous = entry;
      if (decoded.length > w * h) throw new Error('GIF image exceeds its rectangle');
    }
    if (decoded.length !== w * h) throw new Error('Truncated GIF image rectangle');
    const rgba = new Uint8Array(width * height * 4);
    const indices = new Uint8Array(width * height);
    const rows: number[] = [];
    if (flags & 0x40) {
      for (const [start, step] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
      ] as const)
        for (let y = start; y < h; y += step) rows.push(y);
    } else for (let y = 0; y < h; y++) rows.push(y);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++) {
        const index = decoded[row * w + col]!;
        if (index * 3 + 2 >= palette.length)
          throw new Error('GIF palette index outside color table');
        const pixel = (y0 + rows[row]!) * width + x0 + col,
          out = pixel * 4;
        indices[pixel] = index;
        rgba[out] = palette[index * 3]!;
        rgba[out + 1] = palette[index * 3 + 1]!;
        rgba[out + 2] = palette[index * 3 + 2]!;
        rgba[out + 3] = index === transparent ? 0 : 255;
      }
    return {width, height, rgba, indices, pixelFormat: indexed};
  }
  throw new Error('GIF has no image frame');
}

function tiffHeader(bytes: Uint8Array): {
  width: number;
  height: number;
  format: number;
  compression: number;
  samples: number;
  photometric: number;
  bits: number[];
  strips: number[];
  counts: number[];
  rowsPerStrip: number;
  palette: number[];
} {
  if (
    bytes.length < 8 ||
    !((bytes[0] === 73 && bytes[1] === 73) || (bytes[0] === 77 && bytes[1] === 77))
  )
    throw new Error('Invalid TIFF byte order');
  const little = bytes[0] === 73;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => v.getUint16(at, little);
  const u32 = (at: number) => v.getUint32(at, little);
  if (u16(2) !== 42) throw new Error('Unsupported TIFF header');
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) throw new Error('Truncated TIFF directory');
  const count = u16(ifd);
  if (ifd + 2 + count * 12 + 4 > bytes.length) throw new Error('Truncated TIFF entries');
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12,
      id = u16(at),
      type = u16(at + 2),
      length = u32(at + 4);
    if (type !== 3 && type !== 4) continue;
    const size = type === 3 ? 2 : 4,
      total = length * size;
    if (!Number.isSafeInteger(total) || total > bytes.length)
      throw new Error('Invalid TIFF tag count');
    const base = total <= 4 ? at + 8 : u32(at + 8);
    if (base + total > bytes.length) throw new Error('TIFF tag outside file');
    const values = new Array<number>(length);
    for (let n = 0; n < length; n++) values[n] = type === 3 ? u16(base + n * 2) : u32(base + n * 4);
    tags.set(id, values);
  }
  const first = (tag: number, fallback: number) => tags.get(tag)?.[0] ?? fallback;
  const width = first(256, 0),
    height = first(257, 0);
  checkedRaster(width, height);
  const samples = first(277, 1),
    photometric = first(262, 2),
    bits = tags.get(258) ?? [1],
    compression = first(259, 1);
  const format =
    photometric === 3 && bits.every((n) => n <= 8)
      ? indexed
      : photometric === 2 && samples === 3 && bits.every((n) => n === 8)
        ? rgb24
        : photometric === 2 && samples === 4 && bits.every((n) => n === 8)
          ? argb32
          : -1;
  return {
    width,
    height,
    format,
    compression,
    samples,
    photometric,
    bits,
    strips: tags.get(273) ?? [],
    counts: tags.get(279) ?? [],
    rowsPerStrip: first(278, height),
    palette: tags.get(320) ?? [],
  };
}

function tiff(bytes: Uint8Array): Raster | null {
  const header = tiffHeader(bytes);
  if (
    header.compression !== 1 ||
    header.bits.some((n) => n !== 8) ||
    header.strips.length === 0 ||
    header.strips.length !== header.counts.length ||
    (header.photometric !== 2 && header.photometric !== 3)
  )
    return null;
  const {width, height, samples, photometric, rowsPerStrip} = header;
  const pixelSize = photometric === 3 ? 1 : samples;
  if (photometric === 2 && samples !== 3 && samples !== 4) return null;
  const rgba = new Uint8Array(width * height * 4);
  const indices = photometric === 3 ? new Uint8Array(width * height) : undefined;
  for (let strip = 0; strip < header.strips.length; strip++) {
    const startRow = strip * rowsPerStrip;
    if (startRow >= height) break;
    const rows = Math.min(rowsPerStrip, height - startRow),
      offset = header.strips[strip]!,
      count = header.counts[strip]!;
    if (offset + count > bytes.length || count < rows * width * pixelSize)
      throw new Error('Truncated TIFF strip');
    for (let i = 0; i < rows * width; i++) {
      const input = offset + i * pixelSize,
        pixel = startRow * width + i,
        out = pixel * 4;
      if (indices) {
        const index = bytes[input]!;
        indices[pixel] = index;
        if (header.palette.length >= (index + 1) * 3) {
          const tableSize = header.palette.length / 3;
          rgba[out] = header.palette[index]! >>> 8;
          rgba[out + 1] = header.palette[tableSize + index]! >>> 8;
          rgba[out + 2] = header.palette[tableSize * 2 + index]! >>> 8;
        }
        rgba[out + 3] = 255;
      } else {
        rgba[out] = bytes[input]!;
        rgba[out + 1] = bytes[input + 1]!;
        rgba[out + 2] = bytes[input + 2]!;
        rgba[out + 3] = samples === 4 ? bytes[input + 3]! : 255;
      }
    }
  }
  return {width, height, rgba, indices, pixelFormat: header.format};
}

function indexedPixels(raster: Raster): Uint8Array {
  if (raster.indices) return raster.indices;
  const pixels = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < pixels.length; i++) {
    const at = i * 4;
    pixels[i] =
      ((raster.rgba[at]! >>> 5) << 5) |
      ((raster.rgba[at + 1]! >>> 5) << 2) |
      (raster.rgba[at + 2]! >>> 6);
  }
  return pixels;
}

class BrowserGdiBitmap implements WindowsGdiDecodedBitmap {
  constructor(readonly raster: Raster) {}
  get width(): number {
    return this.raster.width;
  }
  get height(): number {
    return this.raster.height;
  }
  get pixelFormat(): number {
    return this.raster.pixelFormat;
  }
  lockBits(pixelFormat: number): WindowsGdiLockedBitmap | null {
    if (pixelFormat !== indexed && pixelFormat !== argb32) return null;
    const {width, height, rgba} = this.raster;
    const stride = (width * (pixelFormat === indexed ? 1 : 4) + 3) & ~3;
    const bytes = new Uint8Array(stride * height);
    if (pixelFormat === indexed) {
      const indices = indexedPixels(this.raster);
      for (let y = 0; y < height; y++)
        bytes.set(indices.subarray(y * width, (y + 1) * width), y * stride);
    } else
      for (let i = 0; i < width * height; i++) {
        const input = i * 4,
          output = Math.floor(i / width) * stride + (i % width) * 4;
        bytes[output] = rgba[input + 2]!;
        bytes[output + 1] = rgba[input + 1]!;
        bytes[output + 2] = rgba[input]!;
        bytes[output + 3] = rgba[input + 3]!;
      }
    return {bytes, scan0Offset: 0, stride, width, height, pixelFormat};
  }
  dispose(): void {}
}

function scan0Rgba(source: WindowsGdiScan0Bitmap): Uint8Array {
  const {width, height, bytes, scan0Offset, scan0Stride, pixelFormat} = source;
  checkedRaster(width, height);
  if (
    (pixelFormat !== rgb32 && pixelFormat !== argb32) ||
    scan0Stride !== width * 4 ||
    scan0Offset < 0 ||
    scan0Offset + scan0Stride * height > bytes.length
  )
    throw new RangeError('Unsupported GDI Scan0 export layout');
  const output = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const input = scan0Offset + i * 4,
      out = i * 4;
    output[out] = bytes[input + 2]!;
    output[out + 1] = bytes[input + 1]!;
    output[out + 2] = bytes[input]!;
    output[out + 3] = pixelFormat === argb32 ? bytes[input + 3]! : 255;
  }
  return output;
}

function encodeBmp(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const row = width * 4,
    result = new Uint8Array(54 + row * height);
  const v = new DataView(result.buffer);
  result[0] = 66;
  result[1] = 77;
  v.setUint32(2, result.length, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  v.setUint32(34, row * height, true);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const input = (y * width + x) * 4,
        out = 54 + ((height - 1 - y) * width + x) * 4;
      result[out] = rgba[input + 2]!;
      result[out + 1] = rgba[input + 1]!;
      result[out + 2] = rgba[input]!;
      result[out + 3] = rgba[input + 3]!;
    }
  return result;
}

function chunk(name: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12),
    v = new DataView(result.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) result[4 + i] = name.charCodeAt(i);
  result.set(data, 8);
  v.setUint32(result.length - 4, pngCrc(result.subarray(4, result.length - 4)));
  return result;
}
async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const stream = new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = new Uint8Array(13),
    v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sections = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ];
  const result = new Uint8Array(sections.reduce((n, part) => n + part.length, 0));
  for (let at = 0, i = 0; i < sections.length; i++) {
    result.set(sections[i]!, at);
    at += sections[i]!.length;
  }
  return result;
}

function encodeTiff(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Baseline little-endian, uncompressed RGB plus one unassociated alpha sample.
  const entries = 11,
    ifd = 8,
    bits = ifd + 2 + entries * 12 + 4;
  const pixelsAt = bits + 8,
    result = new Uint8Array(pixelsAt + rgba.length);
  const v = new DataView(result.buffer);
  result[0] = 73;
  result[1] = 73;
  v.setUint16(2, 42, true);
  v.setUint32(4, ifd, true);
  v.setUint16(ifd, entries, true);
  const tag = (i: number, id: number, type: number, count: number, value: number) => {
    const at = ifd + 2 + i * 12;
    v.setUint16(at, id, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    v.setUint32(at + 8, value, true);
  };
  tag(0, 256, 4, 1, width);
  tag(1, 257, 4, 1, height);
  tag(2, 258, 3, 4, bits);
  tag(3, 259, 3, 1, 1);
  tag(4, 262, 3, 1, 2);
  tag(5, 273, 4, 1, pixelsAt);
  tag(6, 277, 3, 1, 4);
  tag(7, 278, 4, 1, height);
  tag(8, 279, 4, 1, rgba.length);
  tag(9, 284, 3, 1, 1);
  tag(10, 338, 3, 1, 2);
  for (let i = 0; i < 4; i++) v.setUint16(bits + i * 2, 8, true);
  result.set(rgba, pixelsAt);
  return result;
}

function encodeGif(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (width > 65535 || height > 65535) throw new RangeError('GIF dimensions exceed 16-bit header');
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = Math.round((((i >>> 5) & 7) * 255) / 7);
    palette[i * 3 + 1] = Math.round((((i >>> 2) & 7) * 255) / 7);
    palette[i * 3 + 2] = Math.round(((i & 3) * 255) / 3);
  }
  const pixels = new Uint8Array(width * height);
  const used = new Uint32Array(256);
  let transparent = false;
  for (let i = 0; i < pixels.length; i++) {
    const at = i * 4;
    if (rgba[at + 3]! < 128) {
      transparent = true;
      continue;
    }
    const index = ((rgba[at]! >>> 5) << 5) | ((rgba[at + 1]! >>> 5) << 2) | (rgba[at + 2]! >>> 6);
    pixels[i] = index;
    used[index]!++;
  }
  let transparentIndex = 0;
  if (transparent) {
    const unused = used.findIndex((count) => count === 0);
    if (unused >= 0) transparentIndex = unused;
    else {
      // A transparent pixel requires a 257th entry when every opaque bin is used.
      // Merge the least common nonblack bin into its nearest surviving color.
      transparentIndex = 1;
      for (let index = 2; index < 256; index++)
        if (used[index]! < used[transparentIndex]!) transparentIndex = index;
      let replacement = -1,
        distance = Infinity;
      for (let index = 0; index < 256; index++) {
        if (index === transparentIndex) continue;
        const dr = palette[index * 3]! - palette[transparentIndex * 3]!,
          dg = palette[index * 3 + 1]! - palette[transparentIndex * 3 + 1]!,
          db = palette[index * 3 + 2]! - palette[transparentIndex * 3 + 2]!,
          candidate = dr * dr + dg * dg + db * db;
        if (candidate < distance) {
          replacement = index;
          distance = candidate;
        }
      }
      for (let i = 0; i < pixels.length; i++)
        if (rgba[i * 4 + 3]! >= 128 && pixels[i] === transparentIndex) pixels[i] = replacement;
    }
    for (let i = 0; i < pixels.length; i++)
      if (rgba[i * 4 + 3]! < 128) pixels[i] = transparentIndex;
  }
  // A clear code before each index keeps the LZW dictionary empty and the code
  // width fixed at nine bits. It is larger but preserves exact stream semantics.
  const codes = new Uint8Array(Math.ceil(((pixels.length * 2 + 1) * 9) / 8));
  let bit = 0;
  const code = (value: number) => {
    for (let i = 0; i < 9; i++, bit++)
      codes[bit >>> 3] = codes[bit >>> 3]! | (((value >>> i) & 1) << (bit & 7));
  };
  for (const index of pixels) {
    code(256);
    code(index);
  }
  code(257);
  const compressed = codes.subarray(0, Math.ceil(bit / 8));
  const blocks: number[] = [];
  for (let at = 0; at < compressed.length; at += 255) {
    const size = Math.min(255, compressed.length - at);
    blocks.push(size, ...compressed.subarray(at, at + size));
  }
  blocks.push(0);
  const header = new Uint8Array(13);
  header.set([71, 73, 70, 56, 57, 97]);
  const v = new DataView(header.buffer);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  header[10] = 0xf7;
  const descriptor = new Uint8Array(10);
  descriptor[0] = 0x2c;
  new DataView(descriptor.buffer).setUint16(5, width, true);
  new DataView(descriptor.buffer).setUint16(7, height, true);
  const gce = Uint8Array.of(0x21, 0xf9, 4, transparent ? 1 : 0, 0, 0, transparentIndex, 0);
  const sections = [
    header,
    palette,
    gce,
    descriptor,
    Uint8Array.of(8),
    Uint8Array.from(blocks),
    Uint8Array.of(0x3b),
  ];
  const result = new Uint8Array(sections.reduce((n, section) => n + section.length, 0));
  for (let at = 0, i = 0; i < sections.length; i++) {
    result.set(sections[i]!, at);
    at += sections[i]!.length;
  }
  return result;
}

async function encodeJpeg(
  width: number,
  height: number,
  rgba: Uint8Array,
  quality: number,
): Promise<Uint8Array | null> {
  if (quality > 100 || typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: quality / 100});
  if (blob.type !== 'image/jpeg') return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** Pure web five-encoder profile. Browser JPEG/TIFF decoding is delegated to the
 * installed browser decoder; PNG, BMP and GIF retain source indexed metadata. */
export class BrowserGdiImageCodec implements WindowsGdiImageCodecHost {
  async decode(bytes: Uint8Array): Promise<WindowsGdiDecodedBitmap | null> {
    try {
      let raster: Raster;
      if (bytes[0] === 66 && bytes[1] === 77) raster = bmp(bytes);
      else if (bytes[0] === 137 && bytes[1] === 80) {
        const png = await decodePng(bytes);
        raster = {
          width: png.width,
          height: png.height,
          rgba: png.pixels,
          indices: png.indices,
          pixelFormat:
            png.colorType === 3
              ? indexed
              : png.bitDepth === 8 && png.colorType === 2
                ? rgb24
                : png.bitDepth === 8 && png.colorType === 6
                  ? argb32
                  : -1,
        };
      } else if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) raster = gif(bytes);
      else if (bytes[0] === 255 && bytes[1] === 216) {
        const image = await decodeBrowserImage(bytes, 'image/jpeg');
        raster = {width: image.width, height: image.height, rgba: image.pixels, pixelFormat: rgb24};
      } else if ((bytes[0] === 73 && bytes[1] === 73) || (bytes[0] === 77 && bytes[1] === 77)) {
        const header = tiffHeader(bytes);
        const decoded = tiff(bytes);
        if (decoded !== null) raster = decoded;
        else {
          const image = await decodeBrowserImage(bytes, 'image/tiff');
          raster = {
            width: image.width,
            height: image.height,
            rgba: image.pixels,
            pixelFormat: header.format,
          };
        }
      } else return null;
      checkedRaster(raster.width, raster.height);
      return new BrowserGdiBitmap(raster);
    } catch {
      return null;
    }
  }
  encoders(): readonly WindowsGdiEncoder[] {
    return encoders;
  }
  async encode(
    source: WindowsGdiScan0Bitmap,
    encoder: WindowsGdiEncoder,
    quality: number | null,
  ): Promise<Uint8Array | null> {
    try {
      if (!encoders.some((item) => item === encoder)) return null;
      const rgba = scan0Rgba(source),
        {width, height} = source;
      switch (encoder.mime) {
        case 'image/bmp':
          return encodeBmp(width, height, rgba);
        case 'image/jpeg':
          return quality === null ? null : encodeJpeg(width, height, rgba, quality);
        case 'image/gif':
          return encodeGif(width, height, rgba);
        case 'image/tiff':
          return encodeTiff(width, height, rgba);
        case 'image/png':
          return encodePng(width, height, rgba);
      }
      return null;
    } catch {
      return null;
    }
  }
}
