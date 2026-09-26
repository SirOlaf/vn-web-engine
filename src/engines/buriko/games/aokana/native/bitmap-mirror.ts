import {withAokanaBitmapText} from './bitmap-dom-text.js';
import type {AokanaBitmap} from './bitmap.js';
import {copyBlock} from './bitmap-copy.js';

/**0325F0's pixel/row memmoves retain zero-extended DWORD pointer products. */
function mirrorAokanaBitmapPixels(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  mode: number,
): number {
  mode |= 0;
  if (mode !== 0 && mode !== 1) return 0x80000016;
  const rowBytes = Math.imul(source.width, source.bytesPerPixel) >>> 0;
  for (let y = 0; y < destination.height >>> 0; y++) {
    let output = destination.offset + (Math.imul(y, destination.stride) >>> 0);
    if (mode === 1) {
      const input = source.offset + (Math.imul((source.height - y - 1) | 0, source.stride) >>> 0);
      copyBlock(destination, output, source, input, rowBytes);
    } else {
      let input = source.offset + (Math.imul(source.stride, y) >>> 0) + rowBytes;
      for (let x = 0; x < destination.width >>> 0; x++) {
        input -= source.bytesPerPixel >>> 0;
        copyBlock(destination, output, source, input, source.bytesPerPixel >>> 0);
        output += destination.bytesPerPixel >>> 0;
      }
    }
  }
  return 0;
}

export const mirrorAokanaBitmap = withAokanaBitmapText(mirrorAokanaBitmapPixels, {
  replace: true,
  applied: (result) => result === 0,
  map: (x, y, args) => (args[2] === 0 ? [args[1].width - x, y] : [x, args[1].height - y]),
});
