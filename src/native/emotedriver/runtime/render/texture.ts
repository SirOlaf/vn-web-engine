import {
  D3D_OK,
  D3DFMT_A8R8G8B8,
  D3DFMT_DXT5,
  D3DPOOL_MANAGED,
  D3DPTEXTURECAPS_MIPMAP,
} from '../../../d3d9/contract.js';
import type {EmoteTexture} from '../../../../formats/kirikiri/emote-model.js';
import {DXT5_EMOTEDRIVER, Dxt5Decoder, dxt5ByteLength} from '../../../../graphics/s3tc.js';
import {swapRedBlue} from '../../../../graphics/pixel-order.js';
import type {EmoteDeviceCore, EmoteTextureRecord} from './device-core.js';

/**
 * Source texture upload (`MMotionRenderer` slot 1 → 0x10054520). Covers the formats the D3D
 * runtime's motion files use: `RGBA8`/`RGBX8` and `DXT5`. Not lifted: the remaining software
 * converters (A8, L8, A8L8, 565, 5551, 4444, DXT1/3, ETC1, PVRTC) and the resampling of
 * textures above the device's maximum size (0x10059240); those throw.
 */

let decoder: Dxt5Decoder | undefined;

interface Level {
  readonly pixels: Uint8Array;
  /** Uploaded size. */
  readonly width: number;
  readonly height: number;
  /** Source row length in texels and source height (`width`/`height` keys). */
  readonly stride: number;
  readonly sourceHeight: number;
}

/** 0x10052f30, 32 bits per texel. */
function copyRows32(source: Uint8Array, level: Level, pitch: number, bits: Uint8Array): void {
  for (let row = 0; row < level.height; row++) {
    const from = row * level.stride * 4,
      to = row * pitch,
      length = Math.min(level.width * 4, source.length - from, bits.length - to);
    if (length <= 0) return;
    bits.set(source.subarray(from, from + length), to);
  }
}

/**
 * 0x10052f30, 8 bits per texel in 4-row blocks (DXT3/DXT5): each block row copies four
 * `width`-byte runs from consecutive source rows of `stride` bytes.
 */
function copyBlockRows(source: Uint8Array, level: Level, pitch: number, bits: Uint8Array): void {
  let from = 0;
  for (let y = 0, block = 0; y < level.height; y += 4, block++)
    for (let k = 0; k < 4; k++, from += level.stride) {
      const to = block * pitch + k * level.width,
        length = Math.min(level.width, source.length - from, bits.length - to);
      if (length > 0) bits.set(source.subarray(from, from + length), to);
    }
}

/**
 * Creates and fills the texture for one `source.<name>.texture` (0x10054520). `spec` is the
 * PSB root `spec`; `"common"` files store RGBA8 as R, G, B, A and are swizzled on upload.
 */
export function loadEmoteTexture(
  core: EmoteDeviceCore,
  texture: EmoteTexture,
  spec: string,
): EmoteTextureRecord {
  const oversize = core.maxTextureWidth < texture.width || core.maxTextureHeight < texture.height;
  if (oversize)
    throw new Error(
      `E-mote texture ${texture.width}x${texture.height} exceeds the device limit; resampling (0x10059240) is not lifted`,
    );
  let width = texture.width,
    height = texture.height;
  const pow2 = core.textureCaps & 0x102;
  if (pow2 === 0 || pow2 === 0x102) {
    width = texture.truncatedWidth ?? width;
    height = texture.truncatedHeight ?? height;
  }
  const common = spec === 'common',
    type = texture.type;
  let format = D3DFMT_A8R8G8B8,
    convert: ((level: Level) => Uint8Array) | null = null,
    blocks = false;
  if (type === 'RGBA8' || type === 'RGBX8') {
    if (common)
      convert = (level) =>
        swapRedBlue(level.pixels.subarray(0, level.stride * level.sourceHeight * 4)) as Uint8Array;
  } else if (type === 'DXT5' && !common) {
    if (core.formats.dxt5) {
      format = D3DFMT_DXT5;
      blocks = true;
    } else
      convert = (level) => {
        const rgba = (decoder ??= new Dxt5Decoder()).decode(
          level.pixels.subarray(0, dxt5ByteLength(level.stride, level.sourceHeight)),
          level.stride,
          level.sourceHeight,
          DXT5_EMOTEDRIVER,
        );
        return swapRedBlue(rgba, rgba) as Uint8Array;
      };
  } else throw new Error(`E-mote texture type ${type} (spec ${spec}) is not lifted`);

  let levelCount = 1;
  if (
    core.mipMapEnabled &&
    (core.textureCaps & D3DPTEXTURECAPS_MIPMAP) !== 0 &&
    texture.mipMapLevel !== null
  )
    levelCount = texture.mipMapLevel;
  const levels: Level[] = [
    {
      pixels: texture.pixel.bytes,
      width,
      height,
      stride: texture.width,
      sourceHeight: texture.height,
    },
  ];
  for (const mip of texture.mipMap)
    levels.push({
      pixels: mip.pixel.bytes,
      width: mip.width,
      height: mip.height,
      stride: mip.width,
      sourceHeight: mip.height,
    });

  const created = core.device.createTexture(width, height, levelCount, 0, format, D3DPOOL_MANAGED);
  if (created.hr !== D3D_OK || created.value === null)
    throw new Error(`CreateTexture ${width}x${height} failed (${created.hr})`);
  const object = created.value;
  for (let i = 0; i < levelCount && i < levels.length; i++) {
    const level = levels[i]!;
    const locked = object.lockRect(i, null, 0);
    const source = convert === null ? level.pixels : convert(level);
    if (locked.hr === D3D_OK && locked.value !== null) {
      if (blocks) copyBlockRows(source, level, locked.value.pitch, locked.value.bits);
      else copyRows32(source, level, locked.value.pitch, locked.value.bits);
      object.unlockRect(i);
    }
  }
  return {width, height, format, texture: object, alphaOnly: false};
}
