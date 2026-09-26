import {aokanaBitmapTextCompositor, withAokanaBitmapText} from './bitmap-dom-text.js';
import {bitmapStorage, cropAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {bitmapRead8} from './bitmap-scalar.js';
import type {AokanaBitmapCompositor} from './bitmap-compositor.js';

/**046960 ->045170: saturated alpha neighborhoods followed by the actual mode7 erasure. */
function createAokanaHaloMaskPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  radius: number,
  compositor: AokanaBitmapCompositor,
): number {
  radius |= 0;
  if ((radius - 1) >>> 0 > 2) return 0x1a;
  if (destination.format !== 3) return 7;
  if (
    source.width === 0 ||
    (source.width + 15) >>> 0 > destination.width >>> 0 ||
    source.height === 0 ||
    (source.height + 15) >>> 0 > destination.height >>> 0
  )
    return 8;
  if (source.format !== 2) return 0x15;
  clearAokanaBitmap(destination);
  const firstLane = 4 - radius,
    lastLane = 4 + radius;
  let outputRow = destination.offset + 4 + (Math.imul(8 - radius, destination.stride) >>> 0);
  for (let y = 0; y < source.height >>> 0; y++, outputRow += destination.stride | 0) {
    const sourceRow = source.offset + y * (source.stride | 0);
    for (let x = 0; x < source.width >>> 0; x++) {
      const alpha = bitmapRead8(source, sourceRow + x * 4 + 3);
      if (alpha === 0) continue;
      let address = outputRow + x;
      for (let row = 0; row < radius * 2 + 1; row++, address += destination.stride | 0) {
        // Native MOVQ reads all eight lanes before PADDUSB/MOVQ, even the zero lanes.
        const input = bitmapStorage(destination, address, 8, true);
        const previous = input.bytes.slice(address, address + 8);
        const output = bitmapStorage(destination, address, 8, false);
        for (let lane = 0; lane < 8; lane++)
          output.bytes[address + lane] = Math.min(
            255,
            previous[lane]! + (lane >= firstLane && lane <= lastLane ? alpha : 0),
          );
        output.written(address, 8);
      }
    }
  }
  const interior = {...destination};
  cropAokanaBitmap(interior, {
    left: 8,
    top: 8,
    right: (destination.width + 7) | 0,
    bottom: (destination.height + 7) | 0,
  });
  compositor.composite(interior, source, 7, 256, true);
  return 0;
}

export const createAokanaHaloMask = withAokanaBitmapText(createAokanaHaloMaskPixels, {
  alternateArgs: (args) =>
    [args[0], args[1], args[2], aokanaBitmapTextCompositor(args[3])] as Parameters<
      typeof createAokanaHaloMaskPixels
    >,
  replace: true,
  applied: (result) => result === 0,
  map: (x, y) => [x + 8, y + 8],
});
