import {nativeWaveSineRadians} from '../bp/opcodes/native-math.js';
import type {AokanaBitmap} from './bitmap.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {runAokanaBitmapScalarOperation} from './bitmap-operation-jobs.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function truncate32(value: number): number {
  if (!Number.isFinite(value) || value < -0x80000000 || value >= 0x80000000) return -0x80000000;
  return Math.trunc(value) | 0;
}

function interpolate(first: number, second: number, fraction: number): number {
  let result = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const value = (first >>> shift) & 255,
      next = (second >>> shift) & 255;
    result |= (value + (((next - value) * fraction) >> 4)) << shift;
  }
  return result >>> 0;
}

/** 04e700 evaluates one sine per row, then interpolates all four bytes with Q4 weights. */
function wave32(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  period: number,
  phase: number,
  amplitude: number,
): void {
  const sourceWidth = source.width >>> 0,
    destinationWidth = destination.width >>> 0,
    height = Math.min(destination.height >>> 0, source.height >>> 0);
  const center = (sourceWidth - destinationWidth) << 15,
    radiansPerRow = 6.283185307179586 / (period >>> 0),
    strength = amplitude >>> 0;
  const inputStep = (source.stride >> 2) * 4,
    outputStep = (destination.stride >> 2) * 4;
  let inputRow = source.offset,
    outputRow = destination.offset;
  phase |= 0;
  for (let row = 0; row < height; row++) {
    const sine = nativeWaveSineRadians(phase * radiansPerRow);
    // The native source-width reread and width*strength multiply occur after the sine call.
    const shift = ((truncate32(sine * ((source.width >>> 0) * strength)) >> 1) + center) | 0;
    const fraction = (shift >>> 12) & 15;
    let sourceX = shift >> 16;
    const read = (x: number): number =>
      x >>> 0 < sourceWidth ? bitmapRead32(source, inputRow + (x | 0) * 4) : 0;
    let previous = read(sourceX);
    sourceX = (sourceX + 1) | 0;
    let column = 0;
    for (; column + 1 < destinationWidth; column += 2) {
      const first = read(sourceX),
        second = read((sourceX + 1) | 0);
      const firstResult = interpolate(previous, first, fraction),
        secondResult = interpolate(first, second, fraction);
      bitmapWrite32(destination, outputRow + column * 4, firstResult);
      bitmapWrite32(destination, outputRow + column * 4 + 4, secondResult);
      previous = second;
      sourceX = (sourceX + 2) | 0;
    }
    if ((destinationWidth & 1) !== 0)
      bitmapWrite32(
        destination,
        outputRow + column * 4,
        interpolate(previous, read(sourceX), fraction),
      );
    phase = (phase + 1) | 0;
    inputRow += inputStep;
    outputRow += outputStep;
  }
}

/** 04e930 and its 053e80 callback retain the actual mode-five strip phase displacement. */
export function waveAokanaBitmap(
  compositor: AokanaBitmapCompositor,
  destination: AokanaBitmap,
  source: AokanaBitmap,
  period: number,
  phase: number,
  amplitude: number,
  parallel = false,
): void {
  if (
    parallel &&
    runAokanaBitmapScalarOperation(
      compositor.processing,
      [destination, source],
      destination,
      0,
      (bitmaps, row) => {
        waveAokanaBitmap(
          compositor,
          bitmaps[0]!,
          bitmaps[1]!,
          period,
          (phase + row!) | 0,
          amplitude,
        );
      },
      0,
    )
  )
    return;
  if (destination.format !== source.format || (source.format !== 1 && source.format !== 2)) return;
  wave32(destination, source, period, phase, amplitude);
}
