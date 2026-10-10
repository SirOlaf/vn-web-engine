import {
  D3DFMT_A1R5G5B5,
  D3DFMT_A4R4G4B4,
  D3DFMT_A8,
  D3DFMT_A8L8,
  D3DFMT_A8R8G8B8,
  D3DFMT_DXT1,
  D3DFMT_DXT3,
  D3DFMT_DXT5,
  D3DFMT_L8,
  D3DFMT_R5G6B5,
  D3DFMT_X8R8G8B8,
  type D3dRect,
} from '../contract.js';
import {GL} from './gl.js';

/**
 * Texture formats: D3D9 memory layout (what `LockRect` exposes) and the WebGL2 storage that
 * samples identically. Conversion happens at `UnlockRect`.
 */

export const D3DFMT_X1R5G5B5 = 24;
export const D3DFMT_X4R4G4B4 = 30;

export interface TextureFormat {
  readonly format: number;
  /** Bytes per texel, or per 4×4 block for compressed formats. */
  readonly bytes: number;
  readonly compressed: boolean;
  /** GL internal format, format and type for uncompressed storage. */
  readonly internalFormat: number;
  readonly glFormat: number;
  readonly glType: number;
  /** Storage when the texture is a render target (null: not renderable). */
  readonly renderTarget: {
    internalFormat: number;
    glFormat: number;
    glType: number;
    hasAlpha: boolean;
  } | null;
  /** S3TC enumerant for compressed formats. */
  readonly compressedFormat: number;
}

const rgba8 = {internalFormat: GL.RGBA8, glFormat: GL.RGBA, glType: GL.UNSIGNED_BYTE};
const formats = new Map<number, TextureFormat>(
  (
    [
      [D3DFMT_A8R8G8B8, 4, rgba8, {...rgba8, hasAlpha: true}],
      // X8 targets render into RGB8 so destination alpha reads 1, as Direct3D defines.
      [
        D3DFMT_X8R8G8B8,
        4,
        rgba8,
        {internalFormat: GL.RGB8, glFormat: GL.RGB, glType: GL.UNSIGNED_BYTE, hasAlpha: false},
      ],
      ...(
        [
          [D3DFMT_R5G6B5, GL.RGB565, GL.RGB, GL.UNSIGNED_SHORT_5_6_5, false],
          [D3DFMT_X1R5G5B5, GL.RGB5_A1, GL.RGBA, GL.UNSIGNED_SHORT_5_5_5_1, false],
          [D3DFMT_A1R5G5B5, GL.RGB5_A1, GL.RGBA, GL.UNSIGNED_SHORT_5_5_5_1, true],
          [D3DFMT_A4R4G4B4, GL.RGBA4, GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4, true],
          [D3DFMT_X4R4G4B4, GL.RGBA4, GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4, false],
        ] as const
      ).map(([format, internalFormat, glFormat, glType, hasAlpha]) => {
        const storage = {internalFormat, glFormat, glType};
        return [format, 2, storage, {...storage, hasAlpha}] as const;
      }),
      [D3DFMT_A8, 1, {internalFormat: GL.ALPHA, glFormat: GL.ALPHA, glType: GL.UNSIGNED_BYTE}],
      [
        D3DFMT_L8,
        1,
        {internalFormat: GL.LUMINANCE, glFormat: GL.LUMINANCE, glType: GL.UNSIGNED_BYTE},
      ],
      [
        D3DFMT_A8L8,
        2,
        {
          internalFormat: GL.LUMINANCE_ALPHA,
          glFormat: GL.LUMINANCE_ALPHA,
          glType: GL.UNSIGNED_BYTE,
        },
      ],
    ] as const
  ).map(([format, bytes, storage, renderTarget]): [number, TextureFormat] => [
    format,
    {
      format,
      bytes,
      compressed: false,
      ...storage,
      renderTarget: renderTarget ?? null,
      compressedFormat: 0,
    },
  ]),
);
for (const [format, bytes, compressedFormat] of [
  [D3DFMT_DXT1, 8, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT],
  [D3DFMT_DXT3, 16, GL.COMPRESSED_RGBA_S3TC_DXT3_EXT],
  [D3DFMT_DXT5, 16, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT],
] as const)
  formats.set(format, {
    format,
    bytes,
    compressed: true,
    ...rgba8,
    renderTarget: null,
    compressedFormat,
  });

export function textureFormat(format: number): TextureFormat | undefined {
  return formats.get(format);
}

export function isCompressedFormat(format: number): boolean {
  return formats.get(format)?.compressed ?? false;
}

export function supportedTextureFormats(): number[] {
  return [...formats.keys()];
}

/** Row pitch and row count of a level as `LockRect` exposes it. */
export function levelLayout(
  format: TextureFormat,
  width: number,
  height: number,
): {pitch: number; rows: number} {
  return format.compressed
    ? {pitch: Math.ceil(width / 4) * format.bytes, rows: Math.ceil(height / 4)}
    : {pitch: width * format.bytes, rows: height};
}

/**
 * Converts `rect` of a D3D-layout level (`pitch` bytes per row) to tightly packed GL upload
 * data. 16-bit formats return a `Uint16Array`, as WebGL requires for packed types.
 */
export function convertRect(
  format: TextureFormat,
  source: Uint8Array,
  pitch: number,
  rect: D3dRect,
): Uint8Array | Uint16Array {
  const width = rect.right - rect.left,
    height = rect.bottom - rect.top,
    bytes = format.bytes;
  if (bytes === 2 && format.glType !== GL.UNSIGNED_BYTE) {
    const out = new Uint16Array(width * height);
    const convert = packedConverter(format.format);
    let o = 0;
    for (let y = rect.top; y < rect.bottom; y++) {
      let i = y * pitch + rect.left * 2;
      for (let x = 0; x < width; x++, i += 2)
        out[o++] = convert(source[i]! | (source[i + 1]! << 8));
    }
    return out;
  }
  const rowBytes = width * bytes;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const from = (rect.top + y) * pitch + rect.left * bytes;
    out.set(source.subarray(from, from + rowBytes), y * rowBytes);
  }
  if (format.format === D3DFMT_A8R8G8B8 || format.format === D3DFMT_X8R8G8B8) {
    const opaque = format.format === D3DFMT_X8R8G8B8;
    for (let i = 0; i < out.length; i += 4) {
      const b = out[i]!;
      out[i] = out[i + 2]!;
      out[i + 2] = b;
      if (opaque) out[i + 3] = 255;
    }
  }
  return out;
}

/** D3D 16-bit texel (A/X high bits, ARGB order) → GL packed RGBA order (alpha low bits). */
function packedConverter(format: number): (v: number) => number {
  switch (format) {
    case D3DFMT_A1R5G5B5:
      return (v) => ((v << 1) & 0xfffe) | (v >> 15);
    case D3DFMT_X1R5G5B5:
      return (v) => ((v << 1) & 0xfffe) | 1;
    case D3DFMT_A4R4G4B4:
      return (v) => ((v << 4) & 0xfff0) | (v >> 12);
    case D3DFMT_X4R4G4B4:
      return (v) => ((v << 4) & 0xfff0) | 0xf;
    default:
      return (v) => v; // R5G6B5 has the same bit layout in both APIs.
  }
}
