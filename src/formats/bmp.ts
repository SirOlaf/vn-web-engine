import {ByteView} from '../core/binary.js';

/**
 * A Windows device-independent bitmap header: BITMAPCOREHEADER (12 bytes) or
 * BITMAPINFOHEADER and its extensions (40 bytes or more, e.g. V4 108 and V5 124).
 */
export interface DibHeader {
  /** 12, or 40 and above. */
  readonly size: number;
  readonly width: number;
  /** Stored height; negative for top-down rows. */
  readonly storedHeight: number;
  readonly planes: number;
  readonly bitDepth: number;
  /** BI_RGB is 0. Always 0 for a core header. */
  readonly compression: number;
  /** biSizeImage; 0 for a core header. */
  readonly imageSize: number;
  /** biClrUsed; 0 for a core header. */
  readonly colorsUsed: number;
  /** Bytes per palette entry: 3 after a core header, 4 otherwise. */
  readonly paletteEntrySize: number;
  /** V5 profile data offset and size; zero for other headers. */
  readonly profileOffset: number;
  readonly profileSize: number;
}

/** Reads the information header at `offset` without validating its pixel format. */
export function readDibHeader(view: ByteView, offset: number): DibHeader {
  const size = view.u32(offset);
  if (size !== 12 && size < 40) throw new Error(`Unsupported DIB header ${size}`);
  view.check(offset, size);
  if (size === 12)
    return {
      size,
      width: view.u16(offset + 4),
      storedHeight: view.u16(offset + 6),
      planes: view.u16(offset + 8),
      bitDepth: view.u16(offset + 10),
      compression: 0,
      imageSize: 0,
      colorsUsed: 0,
      paletteEntrySize: 3,
      profileOffset: 0,
      profileSize: 0,
    };
  return {
    size,
    width: view.i32(offset + 4),
    storedHeight: view.i32(offset + 8),
    planes: view.u16(offset + 12),
    bitDepth: view.u16(offset + 14),
    compression: view.u32(offset + 16),
    imageSize: view.u32(offset + 20),
    colorsUsed: view.u32(offset + 32),
    paletteEntrySize: 4,
    profileOffset: size === 124 ? view.u32(offset + 112) : 0,
    profileSize: size === 124 ? view.u32(offset + 116) : 0,
  };
}

/** Bytes per row of a DIB, padded to 32 bits. */
export function dibStride(width: number, bitDepth: number): number {
  return Math.ceil((width * bitDepth) / 32) * 4;
}

export interface Bitmap {
  readonly header: DibHeader;
  /** File offset of the pixel rows. */
  readonly dataOffset: number;
  readonly width: number;
  readonly height: number;
  /** Palette as 0xRRGGBB, or null above 8 bits per pixel. */
  readonly palette: Uint32Array | null;
  /** Palette index of each pixel, top-down, or null above 8 bits per pixel. */
  readonly indices: Uint8Array | null;
  /**
   * Colour of each pixel as 0xRRGGBB, top-down. An index outside the palette is black;
   * callers that must reject it check `indices` against `palette`.
   */
  readonly colors: Uint32Array;
}

/**
 * Uncompressed BMP file: a BITMAPFILEHEADER followed by a DIB with 1, 4, 8, 24 or 32-bit
 * BI_RGB pixels, bottom-up or top-down. The high byte of 32-bit pixels is ignored, as GDI
 * ignores it for BI_RGB.
 */
export function decodeBmp(bytes: Uint8Array): Bitmap {
  const view = new ByteView(bytes, {littleEndian: true});
  if (bytes.length < 26 || view.u16(0) !== 0x4d42) throw new Error('Not a BMP image');
  const dataOffset = view.u32(10);
  const header = readDibHeader(view, 14);
  const {width, bitDepth} = header;
  const height = Math.abs(header.storedHeight);
  if (header.planes !== 1 || header.compression !== 0) throw new Error('Unsupported BMP header');
  if (![1, 4, 8, 24, 32].includes(bitDepth)) throw new Error(`Unsupported BMP depth ${bitDepth}`);
  if (width < 1 || height < 1 || width * height > 0x4000000)
    throw new Error('Invalid BMP dimensions');
  const stride = dibStride(width, bitDepth);
  view.check(dataOffset, stride * height);
  let palette: Uint32Array | null = null;
  if (bitDepth <= 8) {
    const count = header.colorsUsed || 1 << bitDepth;
    const start = 14 + header.size,
      entry = header.paletteEntrySize;
    view.check(start, count * entry);
    palette = new Uint32Array(count);
    for (let i = 0; i < count; i++)
      palette[i] =
        bytes[start + i * entry]! |
        (bytes[start + i * entry + 1]! << 8) |
        (bytes[start + i * entry + 2]! << 16);
  }
  const colors = new Uint32Array(width * height);
  const indices = palette ? new Uint8Array(width * height) : null;
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    const row = dataOffset + stride * (header.storedHeight > 0 ? height - 1 - y : y);
    for (let x = 0, out = y * width; x < width; x++, out++) {
      if (bitDepth === 24) {
        const p = row + x * 3;
        colors[out] = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
      } else if (bitDepth === 32) {
        const p = row + x * 4;
        colors[out] = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16);
      } else {
        const bit = x * bitDepth;
        const index = (bytes[row + (bit >> 3)]! >> (8 - bitDepth - (bit & 7))) & mask;
        indices![out] = index;
        colors[out] = palette![index] ?? 0;
      }
    }
  }
  return {header, dataOffset, width, height, palette, indices, colors};
}
