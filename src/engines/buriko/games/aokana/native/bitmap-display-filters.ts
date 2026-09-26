import {aokanaBitmapTextCompositor, withAokanaBitmapText} from './bitmap-dom-text.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
  type AokanaBitmap,
  type AokanaBitmapRectangle,
} from './bitmap.js';
import {
  runAokanaBitmapOperation,
  runAokanaBitmapRectangleOperation,
} from './bitmap-operation-jobs.js';
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
function applyAokanaFilterMaskColorPixels(
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
  const width = source.width >>> 0,
    height = source.height >>> 0;
  const diameter = radius * 2 + 1;
  const reciprocal = Math.trunc((diameter * 2 + 0x20000) / diameter) & 0xffff;
  const lanes = (pixels: readonly number[]): number[] =>
    pixels.flatMap((pixel) => [0, 8, 16, 24].map((bits) => ((pixel >>> bits) & 255) >>> 1));
  const change = (sum: number[], term: readonly number[], sign: number): void => {
    for (let i = 0; i < sum.length; i++) sum[i] = (sum[i]! + sign * term[i]!) & 0xffff;
  };
  const pixel = (sum: readonly number[], start: number): number => {
    let value = 0;
    for (let i = 0; i < 4; i++)
      value |= saturateAokanaByte(Math.imul(sum[start + i]!, reciprocal) >>> 16) << (i * 8);
    return value >>> 0;
  };
  if (!vertical) {
    const sourceStep = (source.stride >> 2) * 4,
      destinationStep = (destination.stride >> 2) * 4;
    for (let y = 0; y < height; y++) {
      const input = source.offset + y * sourceStep,
        output = destination.offset + y * destinationStep;
      const first = clampEdges ? lanes([bitmapRead32(source, input)]) : [0, 0, 0, 0];
      const last = clampEdges
        ? lanes([bitmapRead32(source, input + ((width - 1) >>> 0) * 4)])
        : [0, 0, 0, 0];
      const term = (x: number): number[] => {
        if (clampEdges && x <= 0) return first;
        if (clampEdges && x >= width - 1) return last;
        return x < 0 || x >= width ? [0, 0, 0, 0] : lanes([bitmapRead32(source, input + x * 4)]);
      };
      const sum = [0, 0, 0, 0];
      for (let x = -radius; x <= radius; x++) change(sum, term(x), 1);
      let x = 0;
      for (; x + 1 < width; x += 2) {
        const firstPixel = pixel(sum, 0);
        change(sum, term(x - radius), -1);
        change(sum, term(x + radius + 1), 1);
        const secondPixel = pixel(sum, 0);
        bitmapWrite32(destination, output + x * 4, firstPixel);
        bitmapWrite32(destination, output + (x + 1) * 4, secondPixel);
        change(sum, term(x + 1 - radius), -1);
        change(sum, term(x + radius + 2), 1);
      }
      if (x < width) bitmapWrite32(destination, output + x * 4, pixel(sum, 0));
    }
  } else {
    for (let x = 0; x < width; x += 2) {
      const count = Math.min(2, width - x);
      const readOffset = (displacement: number): number[] => {
        const offset = source.offset + displacement + x * 4;
        return lanes(Array.from({length: count}, (_, i) => bitmapRead32(source, offset + i * 4)));
      };
      // IMUL initializes each pointer once; subsequent ADDs use the signed byte stride.
      const initialOffset = Math.imul(-radius, source.stride);
      const incomingOffset = Math.imul(radius, source.stride);
      const zero = new Array<number>(count * 4).fill(0);
      const first = clampEdges ? readOffset(0) : zero,
        last = clampEdges ? readOffset(Math.imul((height - 1) | 0, source.stride) >>> 0) : zero;
      const term = (y: number, displacement: number): number[] =>
        clampEdges && y <= 0
          ? first
          : clampEdges && y >= height - 1
            ? last
            : y < 0 || y >= height
              ? zero
              : readOffset(displacement);
      const sum = [...zero];
      for (let y = -radius; y <= radius; y++)
        change(sum, term(y, initialOffset + (y + radius) * source.stride), 1);
      for (let y = 0; y < height; y++) {
        const values = Array.from({length: count}, (_, i) => pixel(sum, i * 4));
        for (let i = 0; i < count; i++)
          bitmapWrite32(
            destination,
            destination.offset + y * destination.stride + (x + i) * 4,
            values[i]!,
          );
        change(sum, term(y - radius, initialOffset + y * source.stride), -1);
        change(sum, term(y + radius + 1, incomingOffset + (y + 1) * source.stride), 1);
      }
    }
  }
}

function blurAxis(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  strength: number,
  clamp: boolean,
  vertical: boolean,
  distributed: boolean,
): 0 | 3 | 0xf {
  if (strength >>> 0 > 256) return 3;
  if (
    destination.format !== source.format ||
    destination.width !== source.width ||
    destination.height !== source.height
  )
    return 0xf;
  if (
    distributed &&
    runAokanaBitmapOperation(
      compositor.processing,
      [destination, source],
      source,
      vertical ? 1 : 0,
      (parts) => {
        blurAxis(compositor, parts[0]!, parts[1]!, strength, clamp, vertical, false);
      },
    )
  )
    return 0;
  if (strength === 0) compositor.copy(destination, source);
  else if (source.format === 1 || source.format === 2)
    blurPass(destination, source, Math.min(strength >>> 0, 255), vertical, clamp);
  return 0;
}

/** 04AAD0: axis dispatch precedes copy; two-pass allocation precedes axis validation. */
function applyAokanaEffectorBlurPixels(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  selector: number,
  strength: number,
): 0 | 3 | 10 | 0xe | 0xf {
  selector >>>= 0;
  strength >>>= 0;
  if (selector > 5) return 0xe;
  const clamp = (selector & 1) !== 0;
  if (selector < 4)
    return blurAxis(compositor, destination, source, strength, clamp, selector >= 2, true);
  const temporary = allocateAokanaBitmap(destination.width, destination.height, destination.format);
  if (temporary.storage === null) return 10;
  const first = blurAxis(compositor, temporary, source, strength, clamp, false, true);
  const result =
    first === 0 ? blurAxis(compositor, destination, temporary, strength, clamp, true, true) : first;
  release(temporary);
  return result;
}

interface MapCoordinate {
  x: number;
  y: number;
  fractionX: number;
  fractionY: number;
  denominator: 8 | 16;
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
    if (secondary === null) {
      return {
        x: signedWord(
          x + Math.max(-32768, Math.min(32767, (Math.imul(primaryX, effectLevel) + 8) >> 12)),
        ),
        y: signedWord(
          y + Math.max(-32768, Math.min(32767, (Math.imul(primaryY, effectLevel) + 8) >> 12)),
        ),
        fractionX: 0,
        fractionY: 0,
        denominator: 8,
      };
    }
    if (denominator === 16) {
      scaledX >>= 4;
      scaledY >>= 4;
    } else {
      scaledX = signedWord(scaledX + 4) >> 3;
      scaledY = signedWord(scaledY + 4) >> 3;
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

/** Pair kernels preserve map/sample reads before the native QWORD output store. */
function vectorPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  primary: AokanaBitmap,
  secondary: AokanaBitmap | null,
  level: number,
  bilinear: boolean,
  bounds: AokanaBitmapRectangle,
): void {
  const left = signedWord(bounds.left),
    top = signedWord(bounds.top),
    right = signedWord(bounds.right + 1),
    bottom = signedWord(bounds.bottom + 1);
  const sourcePitch = source.stride >> 2;
  const inside = (x: number, y: number): boolean =>
    x >= left && y >= top && x < right && y < bottom;
  const read = (index: number): number => bitmapRead32(source, source.offset + index * 4);
  const primaryStep = (primary.stride >> 2) * 4,
    secondaryStep = secondary === null ? 0 : (secondary.stride >> 2) * 4,
    outputStep = (destination.stride >> 2) * 4;
  for (let y = 0; y < destination.height >>> 0; y++) {
    for (let x = 0; x < destination.width >>> 0; x += 2) {
      const count = Math.min(2, (destination.width >>> 0) - x);
      const mapOffset = primary.offset + y * primaryStep + x * 4;
      const maps = Array.from({length: count}, (_, i) => bitmapRead32(primary, mapOffset + i * 4));
      const maps2 =
        secondary === null
          ? null
          : Array.from({length: count}, (_, i) =>
              bitmapRead32(secondary, secondary.offset + y * secondaryStep + (x + i) * 4),
            );
      const coordinates = maps.map((value, i) =>
        mapCoordinate(value, maps2?.[i] ?? null, level, x + i, y, bilinear),
      );
      const indices = coordinates.map((c) => (c.x + Math.imul(c.y, signedWord(sourcePitch))) | 0);
      const samples: number[][] = Array.from({length: count}, () => [0, 0, 0, 0]);
      for (let neighbor = 0; neighbor < (bilinear ? 4 : 1); neighbor++) {
        for (let i = 0; i < count; i++) {
          const c = coordinates[i]!,
            dx = neighbor & 1,
            dy = neighbor >> 1;
          if (!inside(signedWord(c.x + dx), signedWord(c.y + dy))) continue;
          const base = indices[i]!;
          // Diagonal +4 bytes occurs after the wrapped/signed bottom index.
          const index = dy ? (base + sourcePitch) | 0 : dx ? (base + 1) | 0 : base;
          samples[i]![neighbor] =
            dy && dx ? bitmapRead32(source, source.offset + index * 4 + 4) : read(index);
        }
      }
      if (bilinear && secondary === null && level === 256 && count === 2) {
        for (let i = 0; i < count; i++) {
          const word = bitmapRead32(primary, mapOffset + i * 4),
            c = coordinates[i]!;
          c.fractionX = word & 15;
          c.fractionY = (word >>> 16) & 15;
        }
      }
      const pixels = samples.map((values, i) => {
        if (!bilinear) return values[0]!;
        const c = coordinates[i]!,
          shift = c.denominator === 16 ? 4 : 3;
        let result = 0;
        for (let bits = 0; bits < 32; bits += 8) {
          const a = (values[0]! >>> bits) & 255,
            b = (values[1]! >>> bits) & 255,
            d = (values[2]! >>> bits) & 255,
            e = (values[3]! >>> bits) & 255;
          const upper = signedWord(a + (signedWord(Math.imul(b - a, c.fractionX)) >> shift));
          const lower = signedWord(d + (signedWord(Math.imul(e - d, c.fractionX)) >> shift));
          const value = signedWord(
            upper + (signedWord(Math.imul(signedWord(lower - upper), c.fractionY)) >> shift),
          );
          result |= saturateAokanaByte(value) << bits;
        }
        return result >>> 0;
      });
      for (let i = 0; i < count; i++)
        bitmapWrite32(destination, destination.offset + y * outputStep + (x + i) * 4, pixels[i]!);
    }
  }
}

/** 04ABB0: the Effector's one- or two-map Q4 screen warp, including endpoint kernels. */
function applyAokanaEffectorVectorMapPixels(
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
  const bounds = aokanaBitmapRectangle(source);
  let selected = primary,
    other = secondary,
    level = effectLevel;
  if (secondary !== null && (level === 0 || level === 256)) {
    selected = level === 0 ? primary : secondary;
    other = null;
    level = 256;
  }
  const bitmaps =
    other === null ? [destination, source, selected] : [destination, source, selected, other];
  const interpolate = (bilinear | 0) !== 0;
  if (
    !runAokanaBitmapRectangleOperation(
      compositor.processing,
      bitmaps,
      source,
      bounds,
      (parts, area) => {
        vectorPixels(parts[0]!, parts[1]!, parts[2]!, parts[3] ?? null, level, interpolate, area);
      },
    )
  )
    vectorPixels(destination, source, selected, other, level, interpolate, bounds);
  return 0;
}

/** Mode-four construction clears the retained full-display buffer in place. */
export function clearAokanaEffectorBuffer(bitmap: AokanaBitmap): void {
  clearAokanaBitmap(bitmap);
}

export const applyAokanaFilterMaskColor = withAokanaBitmapText(applyAokanaFilterMaskColorPixels, {
  source: [0, 2],
  replace: true,
  applied: (_, args) => args[0].format === 1,
});

export const applyAokanaEffectorBlur = withAokanaBitmapText(applyAokanaEffectorBlurPixels, {
  alternateArgs: (args) => {
    const alternate = [...args] as Parameters<typeof applyAokanaEffectorBlurPixels>;
    alternate[0] = aokanaBitmapTextCompositor(args[0]);
    return alternate;
  },
  destination: 1,
  source: 2,
  replace: true,
  applied: (result) => result === 0,
});

export const applyAokanaEffectorVectorMap = withAokanaBitmapText(
  applyAokanaEffectorVectorMapPixels,
  {
    alternateArgs: (args) => {
      const alternate = [...args] as Parameters<typeof applyAokanaEffectorVectorMapPixels>;
      alternate[0] = aokanaBitmapTextCompositor(args[0]);
      return alternate;
    },
    destination: 1,
    source: 2,
    replace: true,
    applied: (result, args) => result === 0 && (args[2].format === 1 || args[2].format === 2),
    map: (x, y, args) => {
      const primary = args[3],
        secondary = args[4];
      if (primary.width <= 0 || primary.height <= 0) return [NaN, NaN];
      let outputX = x,
        outputY = y;
      for (let iteration = 0; iteration < 4; iteration++) {
        const column = Math.max(0, Math.min(primary.width - 1, Math.floor(outputX))),
          row = Math.max(0, Math.min(primary.height - 1, Math.floor(outputY))),
          first = bitmapRead32(primary, primary.offset + row * primary.stride + column * 4),
          second =
            secondary === null
              ? null
              : bitmapRead32(secondary, secondary.offset + row * secondary.stride + column * 4),
          sample = mapCoordinate(first, second, args[5], column, row, args[6] !== 0);
        outputX = x - (sample.x + sample.fractionX / sample.denominator - column);
        outputY = y - (sample.y + sample.fractionY / sample.denominator - row);
      }
      return [outputX, outputY];
    },
  },
);
