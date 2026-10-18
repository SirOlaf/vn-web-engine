import {PsbResource, type PsbObject, type PsbValue} from './psb.js';

/**
 * E-mote source textures (`source.<name>.texture`) as the Direct3D runtime emotedriver.dll
 * (SHA-256 `a3b693b6…5e70b3a86`) reads and uploads them; loader 0x10054520.
 *
 * Descriptor: `type`, `width`, `height`, optional `truncated_width`/`truncated_height`,
 * `pixel` (level 0), `mipMapLevel` and `mipMap` (levels 1.., each `width`, `height`,
 * `pixel`). The texture is created with the truncated size (the full `width` is the source
 * row stride) unless it exceeds the device's maximum texture size.
 *
 * Upload (`IDirect3DDevice9::CreateTexture`, `D3DPOOL_MANAGED`, usage 0, then `LockRect` and
 * a row copy per level, no swizzle or premultiplication):
 * - Level count is `mipMapLevel` only when `mipMapEnabled` is set and the device reports
 *   `D3DPTEXTURECAPS_MIPMAP`; otherwise level 0 alone.
 * - Root `spec` other than `"common"` (NEKOPARA: `"win"`): `RGBA8` is uploaded unchanged as
 *   `D3DFMT_A8R8G8B8`, so its stored byte order is B, G, R, A. `DXT1`/`DXT3`/`DXT5` become
 *   `D3DFMT_DXT1/3/5` with blocks copied unchanged when `CheckDeviceFormat` accepts them;
 *   otherwise a CPU converter decodes to A8R8G8B8 (see `src/graphics/s3tc.ts`,
 *   `DXT5_EMOTEDRIVER`).
 * - `spec` `"common"`: `RGBA8`/`RGBX8` are stored R, G, B, A and swapped to A8R8G8B8 on
 *   upload (0x100542d0); compressed formats are not accepted there.
 * - A texture larger than the maximum texture size is converted on the CPU, resampled to
 *   the limit and uploaded without mip levels.
 *
 * `EmoteFilterTexture` (0x10002c20) calls a caller-supplied filter on the `pixel` bytes of
 * every `RGBA8` texture and its mip levels; it is exported for tooling and not called by
 * drawdeviceD3DZ.dll. `protectTranslucentTextureColor` is a draw-time blend pass, not an
 * upload transform.
 */

export interface EmoteTextureLevel {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface EmoteTexture {
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly truncatedWidth: number;
  readonly truncatedHeight: number;
  /** Level 0 followed by the `mipMap` entries, in file order. */
  readonly levels: readonly EmoteTextureLevel[];
  /** `mipMapLevel`, or 1 when absent. */
  readonly mipMapLevel: number;
}

/** Stored byte order of an `RGBA8` texture for the root `spec` of its PSB. */
export function emoteRgba8ByteOrder(spec: PsbValue): 'bgra' | 'rgba' {
  return spec === 'common' ? 'rgba' : 'bgra';
}

/** Expected byte length of one level, or null for formats this reader does not size. */
export function emoteTextureLevelLength(
  type: string,
  width: number,
  height: number,
): number | null {
  if (type === 'RGBA8' || type === 'RGBX8') return width * height * 4;
  if (type === 'DXT5' || type === 'DXT3') return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  if (type === 'DXT1') return Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
  return null;
}

function integer(object: PsbObject, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`E-mote texture has an invalid ${key}`);
  return value;
}

function level(object: PsbObject, type: string): EmoteTextureLevel {
  const width = integer(object, 'width'),
    height = integer(object, 'height'),
    pixel = object.pixel;
  if (!(pixel instanceof PsbResource)) throw new Error('E-mote texture level has no pixel data');
  const length = emoteTextureLevelLength(type, width, height);
  if (length !== null && pixel.bytes.length < length)
    throw new Error(`E-mote ${type} level ${width}x${height} has ${pixel.bytes.length} bytes`);
  return {width, height, pixels: pixel.bytes};
}

export function readEmoteTexture(texture: PsbObject): EmoteTexture {
  const type = texture.type;
  if (typeof type !== 'string') throw new Error('E-mote texture has no type');
  const base = level(texture, type),
    truncatedWidth =
      texture.truncated_width === undefined ? base.width : integer(texture, 'truncated_width'),
    truncatedHeight =
      texture.truncated_height === undefined ? base.height : integer(texture, 'truncated_height'),
    mipMapLevel = texture.mipMapLevel === undefined ? 1 : integer(texture, 'mipMapLevel'),
    mipMap = texture.mipMap ?? [];
  if (!Array.isArray(mipMap)) throw new Error('E-mote texture mipMap is not a list');
  const levels = [base];
  for (const entry of mipMap as readonly PsbValue[]) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      entry instanceof PsbResource
    )
      throw new Error('E-mote texture mipMap entry is not an object');
    levels.push(level(entry as PsbObject, type));
  }
  return {
    type,
    width: base.width,
    height: base.height,
    truncatedWidth,
    truncatedHeight,
    levels,
    mipMapLevel,
  };
}
