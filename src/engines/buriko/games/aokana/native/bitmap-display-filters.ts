import {allocateAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {aokanaSignedProduct16, saturateAokanaByte} from './bitmap-pairs.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function signedWord(value: number): number {
  return (value << 16) >> 16;
}

function signedHighWord(left: number, right: number): number {
  return Math.imul(signedWord(left), signedWord(right)) >> 16;
}

function release(bitmap: AokanaBitmap): void {
  bitmap.storage?.release();
}

/** 045B10: format-three coverage selects a color through the Filter's shifted threshold. */
export function applyAokanaFilterMaskColor(
  destination: AokanaBitmap,
  color: number,
  mask: AokanaBitmap,
  shift: number,
  effectLevel: number,
): void {
  if (destination.format !== 1) return;
  color &= 0xffffff;
  const bit = 1 << (shift & 31);
  for (let y = 0; y < destination.height >>> 0; y++) {
    const outputRow = destination.offset + y * destination.stride;
    const maskRow = mask.offset + y * mask.stride;
    for (let x = 0; x < destination.width >>> 0; x++) {
      const coverage = bitmapRead8(mask, maskRow + x);
      const distance = (Math.imul(coverage, bit) + Math.imul(~bit, effectLevel | 0) + 0x100) | 0;
      if (distance >= 0x100) continue;
      const output = outputRow + x * 4;
      if (distance < 1) {
        bitmapWrite32(destination, output, color);
        continue;
      }
      const previous = bitmapRead32(destination, output);
      const coefficient = distance >> 1;
      let pixel = 0;
      for (let channel = 0; channel < 3; channel++) {
        const bits = channel * 8;
        const target = (color >>> bits) & 0xff;
        const value = (previous >>> bits) & 0xff;
        pixel |=
          saturateAokanaByte(target + (aokanaSignedProduct16(value - target, coefficient) >> 7)) <<
          bits;
      }
      bitmapWrite32(destination, output, pixel >>> 0);
    }
  }
}

function blurPass(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  radius: number,
  vertical: boolean,
  clampEdges: boolean,
): void {
  const width = destination.width >>> 0;
  const height = destination.height >>> 0;
  const diameter = radius * 2 + 1;
  const reciprocal = Math.trunc((diameter * 2 + 0x20000) / diameter) & 0xffff;
  const read = (x: number, y: number): number => {
    if (clampEdges) {
      x = Math.max(0, Math.min(width - 1, x));
      y = Math.max(0, Math.min(height - 1, y));
    } else if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return bitmapRead32(source, source.offset + y * source.stride + x * 4);
  };
  for (let y = 0; y < height; y++) {
    const outputRow = destination.offset + y * destination.stride;
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      for (let offset = -radius; offset <= radius; offset++) {
        const pixel = read(vertical ? x : x + offset, vertical ? y + offset : y);
        for (let channel = 0; channel < 4; channel++)
          sums[channel] = (sums[channel]! + (((pixel >>> (channel * 8)) & 0xff) >>> 1)) & 0xffff;
      }
      let pixel = 0;
      for (let channel = 0; channel < 4; channel++)
        pixel |= ((Math.imul(sums[channel]!, reciprocal) >>> 16) & 0xff) << (channel * 8);
      bitmapWrite32(destination, outputRow + x * 4, pixel >>> 0);
    }
  }
}

/** 04AAD0 with 0492D0/048D20/0486B0: six zero/clamped separable blur selectors. */
export function applyAokanaEffectorBlur(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  selector: number,
  strength: number,
): 0 | 3 | 0xe | 0xf {
  selector >>>= 0;
  strength >>>= 0;
  if (selector > 5) return 0xe;
  if (strength > 0x100) return 3;
  if (
    destination.format !== source.format ||
    destination.width !== source.width ||
    destination.height !== source.height
  )
    return 0xf;
  if (strength === 0) {
    compositor.copy(destination, source);
    return 0;
  }
  if (source.format !== 1 && source.format !== 2) return 0;
  const radius = Math.min(strength, 0xff);
  const clampEdges = (selector & 1) !== 0;
  if (selector < 2) blurPass(destination, source, radius, false, clampEdges);
  else if (selector < 4) blurPass(destination, source, radius, true, clampEdges);
  else {
    const temporary = allocateAokanaBitmap(source.width, source.height, source.format);
    blurPass(temporary, source, radius, false, clampEdges);
    blurPass(destination, temporary, radius, true, clampEdges);
    release(temporary);
  }
  return 0;
}

interface MapCoordinate {
  x: number;
  y: number;
  fractionX: number;
  fractionY: number;
  denominator: 8 | 16;
}

function mapWord(map: AokanaBitmap, x: number, y: number): number {
  return bitmapRead32(map, map.offset + y * map.stride + x * 4);
}

function mapCoordinate(
  primary: number,
  secondary: number | null,
  effectLevel: number,
  x: number,
  y: number,
  bilinear: boolean,
): MapCoordinate {
  const primaryX = signedWord(primary);
  const primaryY = signedWord(primary >>> 16);
  let scaledX: number;
  let scaledY: number;
  let denominator: 8 | 16;
  if (secondary !== null && (effectLevel === 0 || effectLevel === 0x100)) {
    const selected = effectLevel === 0 ? primary : secondary;
    scaledX = signedWord(selected);
    scaledY = signedWord(selected >>> 16);
    denominator = 16;
  } else if (secondary === null && effectLevel === 0x100) {
    scaledX = primaryX;
    scaledY = primaryY;
    denominator = 16;
  } else if (secondary === null) {
    const coefficient = signedWord(Math.imul(effectLevel, 0x80));
    scaledX = signedHighWord(primaryX, coefficient);
    scaledY = signedHighWord(primaryY, coefficient);
    denominator = 8;
  } else {
    const coefficient = signedWord(Math.imul(effectLevel, 0x80));
    const secondaryX = signedWord(secondary);
    const secondaryY = signedWord(secondary >>> 16);
    scaledX = signedWord(
      (primaryX >> 1) + signedHighWord(signedWord(secondaryX - primaryX), coefficient),
    );
    scaledY = signedWord(
      (primaryY >> 1) + signedHighWord(signedWord(secondaryY - primaryY), coefficient),
    );
    denominator = 8;
  }
  if (!bilinear) {
    if (secondary === null && effectLevel !== 0x100) {
      return {
        x: signedWord(x + ((Math.imul(primaryX, effectLevel) + 8) >> 12)),
        y: signedWord(y + ((Math.imul(primaryY, effectLevel) + 8) >> 12)),
        fractionX: 0,
        fractionY: 0,
        denominator: 8,
      };
    }
    if (denominator === 16) {
      scaledX >>= 4;
      scaledY >>= 4;
    } else {
      scaledX = (scaledX + 4) >> 3;
      scaledY = (scaledY + 4) >> 3;
    }
    return {
      x: signedWord(x + scaledX),
      y: signedWord(y + scaledY),
      fractionX: 0,
      fractionY: 0,
      denominator,
    };
  }
  const shift = denominator === 16 ? 4 : 3;
  return {
    x: signedWord(x + (scaledX >> shift)),
    y: signedWord(y + (scaledY >> shift)),
    fractionX: scaledX & (denominator - 1),
    fractionY: scaledY & (denominator - 1),
    denominator,
  };
}

function sampleMappedPixel(
  source: AokanaBitmap,
  coordinate: MapCoordinate,
  bilinear: boolean,
): number {
  const pitch = signedWord(source.stride >> 2);
  const width = signedWord(source.width);
  const height = signedWord(source.height);
  const read = (x: number, y: number): number => {
    const index = (x + Math.imul(y, pitch)) | 0;
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    return inside ? bitmapRead32(source, source.offset + index * 4) : 0;
  };
  const {x, y, fractionX, fractionY, denominator} = coordinate;
  const first = read(x, y);
  if (!bilinear) return first;
  const right = read(signedWord(x + 1), y);
  const bottom = read(x, signedWord(y + 1));
  const diagonal = read(signedWord(x + 1), signedWord(y + 1));
  const shift = denominator === 16 ? 4 : 3;
  let pixel = 0;
  for (let bits = 0; bits < 32; bits += 8) {
    const upperLeft = (first >>> bits) & 0xff;
    const lowerLeft = (bottom >>> bits) & 0xff;
    const upper = upperLeft + (((((right >>> bits) & 0xff) - upperLeft) * fractionX) >> shift);
    const lower = lowerLeft + (((((diagonal >>> bits) & 0xff) - lowerLeft) * fractionX) >> shift);
    pixel |= (upper + (((lower - upper) * fractionY) >> shift)) << bits;
  }
  return pixel >>> 0;
}

/** 04ABB0: the Effector's one- or two-map Q4 screen warp, including endpoint kernels. */
export function applyAokanaEffectorVectorMap(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  primary: AokanaBitmap,
  secondary: AokanaBitmap | null,
  effectLevel: number,
  bilinear: number,
): 0 | 1 | 3 | 0xc | 0xd {
  effectLevel >>>= 0;
  if (effectLevel > 0x100) return 3;
  if (
    primary.format !== 4 ||
    primary.width >>> 0 < destination.width >>> 0 ||
    primary.height >>> 0 < destination.height >>> 0
  )
    return 0xc;
  if (
    secondary !== null &&
    (secondary.format !== 4 ||
      secondary.width !== primary.width ||
      secondary.height !== primary.height)
  )
    return 0xd;
  if (destination.format !== source.format) return 1;
  if (source.format !== 1 && source.format !== 2) return 0;
  if (secondary === null && effectLevel === 0) {
    compositor.copy(destination, source);
    return 0;
  }
  const interpolate = (bilinear | 0) !== 0;
  for (let y = 0; y < destination.height >>> 0; y++) {
    const outputRow = destination.offset + y * destination.stride;
    for (let x = 0; x < destination.width >>> 0; x++) {
      const first = mapWord(primary, x, y);
      const second = secondary === null ? null : mapWord(secondary, x, y);
      const coordinate = mapCoordinate(first, second, effectLevel, x, y, interpolate);
      bitmapWrite32(
        destination,
        outputRow + x * 4,
        sampleMappedPixel(source, coordinate, interpolate),
      );
    }
  }
  return 0;
}

/** Mode-four construction clears the retained full-display buffer in place. */
export function clearAokanaEffectorBuffer(bitmap: AokanaBitmap): void {
  clearAokanaBitmap(bitmap);
}
