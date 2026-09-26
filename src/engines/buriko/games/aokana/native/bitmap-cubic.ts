import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaBitmap} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {runAokanaBitmapFloatPointOperation} from './bitmap-operation-jobs.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {aokanaRosettaSseReciprocal} from './cpu-numerical-profile.js';
import {roundToInt32} from '../bp/opcodes/fixed.js';

const f32 = Math.fround;
function truncate(value: number): number {
  return Number.isFinite(value) && value >= -0x80000000 && value < 0x80000000
    ? Math.trunc(value) | 0
    : -0x80000000;
}
/** 044B40's separately rounded cubic polynomial; unordered distances are skipped. */
function weight(distance: number): number {
  const x = Math.abs(distance);
  if (!(x < 2)) return 0;
  const square = f32(x * x);
  return x < 1
    ? f32(f32(1 - f32(square + square)) + f32(square * x))
    : f32(f32(f32(4 - f32(8 * x)) + f32(5 * square)) - f32(square * x));
}

function cubicPixels(
  destination: AokanaBitmap,
  destinationX: number,
  destinationY: number,
  source: AokanaBitmap,
  sourceX: number,
  sourceY: number,
  scaleX: number,
  scaleY: number,
): void {
  // Native divides in double, then converts each reciprocal to float before MULSS.
  const stepX = f32(1 / scaleX),
    stepY = f32(1 / scaleY);
  const firstX = f32(sourceX - f32(stepX * destinationX));
  let rowCoordinate = f32(sourceY - f32(stepY * destinationY));
  for (let y = 0; y < destination.height >>> 0; y++) {
    const firstRow = (truncate(rowCoordinate) - 1) | 0,
      lastRow = (truncate(rowCoordinate) + 2) | 0;
    const rowOffset = Math.imul(y, destination.stride);
    let columnCoordinate = firstX;
    for (let x = 0; x < destination.width >>> 0; x++) {
      let total = 0;
      const sums = [0, 0, 0, 0];
      // Initial row offset wraps once; subsequent native pointer ADDs do not re-IMUL.
      let sourceRow = Math.imul(firstRow, source.stride),
        row64 = firstRow;
      for (
        let row = firstRow;
        row <= lastRow;
        row = (row + 1) | 0, row64++, sourceRow += source.stride
      ) {
        const wy = weight(f32(rowCoordinate - f32(row)));
        if (wy === 0) continue;
        const firstColumn = (truncate(columnCoordinate) - 1) | 0,
          lastColumn = (truncate(columnCoordinate) + 2) | 0;
        let column64 = firstColumn,
          address = source.offset + sourceRow + firstColumn * 4;
        for (
          let column = firstColumn;
          column <= lastColumn;
          column = (column + 1) | 0, column64++, address += 4
        ) {
          const wx = weight(f32(columnCoordinate - f32(column)));
          if (
            wx === 0 ||
            column < 0 ||
            column64 >= (source.width | 0) ||
            row < 0 ||
            row64 >= (source.height | 0)
          )
            continue;
          const pixel = bitmapRead32(source, address),
            combined = f32(wx * wy);
          total = f32(total + combined);
          for (let channel = 0; channel < 4; channel++)
            sums[channel] = f32(sums[channel]! + f32(((pixel >>> (channel * 8)) & 255) * combined));
        }
      }
      columnCoordinate = f32(columnCoordinate + stepX);
      const seed = total === 0 ? 1 / total : aokanaRosettaSseReciprocal(total);
      const reciprocal = f32(f32(seed + seed) - f32(f32(seed * seed) * total));
      let pixel = 0;
      for (let channel = 0; channel < 4; channel++) {
        const value = roundToInt32(f32(reciprocal * sums[channel]!));
        pixel |= Math.max(0, Math.min(255, value)) << (channel * 8);
      }
      bitmapWrite32(
        destination,
        destination.offset + ((rowOffset + Math.imul(x, 4)) >>> 0),
        pixel >>> 0,
      );
    }
    rowCoordinate = f32(rowCoordinate + stepY);
  }
}

/** 045000 validates scales, then dispatches mode three before its format gate. */
function stretchAokanaBitmapCubicPixels(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  destinationX: number,
  destinationY: number,
  source: AokanaBitmap,
  sourceX: number,
  sourceY: number,
  scaleX: number,
  scaleY: number,
  parallel = true,
): 0 | 0x13 {
  destinationX = f32(destinationX);
  destinationY = f32(destinationY);
  sourceX = f32(sourceX);
  sourceY = f32(sourceY);
  scaleX = f32(scaleX);
  scaleY = f32(scaleY);
  if (!(scaleX > 0) || !(scaleY > 0)) return 0x13;
  if (
    parallel &&
    runAokanaBitmapFloatPointOperation(
      compositor.processing,
      destination,
      [destinationX, destinationY],
      (part, pivot) => {
        stretchAokanaBitmapCubic(
          compositor,
          part,
          pivot[0],
          pivot[1],
          source,
          sourceX,
          sourceY,
          scaleX,
          scaleY,
          false,
        );
      },
    )
  )
    return 0;
  if (destination.format === source.format && (source.format === 1 || source.format === 2))
    cubicPixels(destination, destinationX, destinationY, source, sourceX, sourceY, scaleX, scaleY);
  return 0;
}

export const stretchAokanaBitmapCubic = withAokanaBitmapText(stretchAokanaBitmapCubicPixels, {
  alternateArgs: (args) => {
    const alternate = [...args] as Parameters<typeof stretchAokanaBitmapCubicPixels>;
    alternate[9] = false;
    return alternate;
  },
  destination: 1,
  source: 4,
  replace: true,
  applied: (result, args) =>
    result === 0 &&
    args[1].format === args[4].format &&
    (args[4].format === 1 || args[4].format === 2),
  map: (x, y, args) => [(x - args[5]) * args[7] + args[2], (y - args[6]) * args[8] + args[3]],
});
