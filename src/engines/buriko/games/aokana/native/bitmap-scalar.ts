import {bitmapStorage, type AokanaBitmap} from './bitmap.js';

export function bitmapRead8(bitmap: AokanaBitmap, offset: number): number {
  return bitmapStorage(bitmap, offset, 1, true).bytes[offset]!;
}
export function bitmapRead16(bitmap: AokanaBitmap, offset: number): number {
  return bitmapStorage(bitmap, offset, 2, true).view.getUint16(offset, true);
}
export function bitmapRead32(bitmap: AokanaBitmap, offset: number): number {
  return bitmapStorage(bitmap, offset, 4, true).view.getUint32(offset, true);
}
export function bitmapWrite8(bitmap: AokanaBitmap, offset: number, value: number): void {
  const storage = bitmapStorage(bitmap, offset, 1, false);
  storage.bytes[offset] = value;
  storage.written(offset, 1);
}
export function bitmapWrite16(bitmap: AokanaBitmap, offset: number, value: number): void {
  const storage = bitmapStorage(bitmap, offset, 2, false);
  storage.view.setUint16(offset, value, true);
  storage.written(offset, 2);
}
export function bitmapWrite32(bitmap: AokanaBitmap, offset: number, value: number): void {
  const storage = bitmapStorage(bitmap, offset, 4, false);
  storage.view.setUint32(offset, value, true);
  storage.written(offset, 4);
}

function mix555(source: number, destination: number, destinationWeight: number): number {
  const sourceWeight = (256 - destinationWeight) | 0;
  let value = 0;
  for (const shift of [0, 5, 10])
    value |=
      (((Math.imul((source >>> shift) & 31, sourceWeight) +
        Math.imul((destination >>> shift) & 31, destinationWeight)) >>
        8) &
        31) <<
      shift;
  return value;
}

/** 14003dae0 walks each 16-bit row backwards, treating zero as transparent. */
export function copyAokanaTransparent16(destination: AokanaBitmap, source: AokanaBitmap): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = (source.width >>> 0) - 1; x >= 0; x--) {
      const pixel = bitmapRead16(source, source.offset + y * source.stride + x * 2);
      if (pixel !== 0)
        bitmapWrite16(destination, destination.offset + y * destination.stride + x * 2, pixel);
    }
}

/** 14003d4e0/14003c900 differ only in whether a zero source pixel suppresses the write. */
export function mixAokana16(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  destinationWeight: number,
  zeroTransparent: boolean,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = (source.width >>> 0) - 1; x >= 0; x--) {
      const sourceOffset = source.offset + y * source.stride + x * 2;
      const destinationOffset = destination.offset + y * destination.stride + x * 2;
      const pixel = bitmapRead16(source, sourceOffset);
      if (pixel !== 0 || !zeroTransparent)
        bitmapWrite16(
          destination,
          destinationOffset,
          mix555(pixel, bitmapRead16(destination, destinationOffset), destinationWeight),
        );
    }
}

/** 14003bd30 saturates each 5-bit component after the source's /256 multiplication. */
export function addAokana16(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = (source.width >>> 0) - 1; x >= 0; x--) {
      const sourceOffset = source.offset + y * source.stride + x * 2;
      const destinationOffset = destination.offset + y * destination.stride + x * 2;
      const pixel = bitmapRead16(source, sourceOffset);
      if (pixel !== 0) {
        const old = bitmapRead16(destination, destinationOffset);
        let value = 0;
        for (const shift of [0, 5, 10])
          value |=
            Math.min(
              31,
              ((Math.imul((pixel >>> shift) & 31, opacity) >>> 8) + ((old >>> shift) & 31)) >>> 0,
            ) << shift;
        bitmapWrite16(destination, destinationOffset, value);
      }
    }
}

/** 140046730 tints all source pixels, including zero, against an RGB888 constant. */
export function tintAokana16(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  color: number,
  opacity: number,
): void {
  const tint = ((color >>> 9) & 0x7c00) + ((color >>> 6) & 0x3e0) + ((color >>> 3) & 31);
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = (source.width >>> 0) - 1; x >= 0; x--) {
      const pixel = bitmapRead16(source, source.offset + y * source.stride + x * 2);
      bitmapWrite16(
        destination,
        destination.offset + y * destination.stride + x * 2,
        mix555(pixel, tint, opacity),
      );
    }
}

/** 140039e30 clears the destination where the 16-bit source word is nonzero. */
export function eraseAokana16(destination: AokanaBitmap, source: AokanaBitmap): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = (source.width >>> 0) - 1; x >= 0; x--)
      if (bitmapRead16(source, source.offset + y * source.stride + x * 2) !== 0)
        bitmapWrite16(destination, destination.offset + y * destination.stride + x * 2, 0);
}

/** 140039d80/cd0/c30/b90 retain the source/target descriptor's independent pixel strides. */
export function eraseAokana32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  partialAlpha: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const sourceOffset = source.offset + y * source.stride + x * (source.bytesPerPixel >>> 0);
      let erase: boolean;
      if (source.format === 1)
        erase =
          bitmapRead8(source, sourceOffset) +
            bitmapRead8(source, sourceOffset + 1) +
            bitmapRead8(source, sourceOffset + 2) !==
          0;
      else {
        erase =
          partialAlpha === 0
            ? bitmapRead8(source, sourceOffset + 3) === 255
            : (bitmapRead32(source, sourceOffset) & 0xff000000) !== 0;
      }
      if (erase)
        bitmapWrite32(
          destination,
          destination.offset + y * destination.stride + x * (destination.bytesPerPixel >>> 0),
          0,
        );
    }
}

/** 14003bc00/14003bab0 read each channel after the preceding aliased destination store. */
export function addAokanaOpaque32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  opacity: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const sourceOffset = source.offset + y * source.stride + x * (source.bytesPerPixel >>> 0);
      const destinationOffset =
        destination.offset + y * destination.stride + x * (destination.bytesPerPixel >>> 0);
      if (
        bitmapRead8(source, sourceOffset) +
          bitmapRead8(source, sourceOffset + 1) +
          bitmapRead8(source, sourceOffset + 2) ===
        0
      )
        continue;
      for (let channel = 0; channel < 3; channel++) {
        const value =
          ((Math.imul(bitmapRead8(source, sourceOffset + channel), opacity) >>> 8) +
            bitmapRead8(destination, destinationOffset + channel)) >>>
          0;
        bitmapWrite8(destination, destinationOffset + channel, Math.min(255, value));
      }
      if (destination.format === 2)
        bitmapWrite8(
          destination,
          destinationOffset + 3,
          Math.min(255, (bitmapRead8(destination, destinationOffset + 3) + opacity) >>> 0),
        );
    }
}

/** 140045900's channel-isolation mode preserves its unusual red-channel mask. */
export function isolateAokanaChannel(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  channel: number,
): void {
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const sourceOffset = source.offset + y * source.stride + x * 4;
      let value: number;
      if (channel === 0) value = bitmapRead8(source, sourceOffset);
      else if (channel === 1) value = bitmapRead32(source, sourceOffset) & 0xff00;
      else if (channel === 2) value = bitmapRead32(source, sourceOffset) & 0xffff0000;
      else if (channel === 3) value = bitmapRead8(source, sourceOffset + 3) * 0x10101;
      else continue;
      bitmapWrite32(
        destination,
        destination.offset + y * destination.stride + x * 4,
        value | 0xff000000,
      );
    }
}
