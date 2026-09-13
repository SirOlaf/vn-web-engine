import {aokanaBitmapPixelSize, bitmapStorage, type AokanaBitmap} from './bitmap.js';

/** 1400b7390's untransformed StretchDIBits input used by every auxiliary-window caller. */
export function aokanaChildDibPixels(bitmap: AokanaBitmap): Uint8ClampedArray<ArrayBuffer> | null {
  const bits = aokanaBitmapPixelSize(bitmap.format) << 3;
  // BI_RGB has no 48-bit DIB interpretation; StretchDIBits fails without changing the DC.
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
  if (bits === 8)
    throw new Error('Aokana child DIB reads the native uninitialized eight-bit color table');
  const width = bitmap.width | 0;
  const height = bitmap.height | 0;
  if (width <= 0 || height <= 0) return null;
  const output = new Uint8ClampedArray(width * height * 4);
  // The native BITMAPINFO does not carry the descriptor stride. DIB rows are DWORD-aligned.
  const stride = Math.floor((width * bits + 31) / 32) * 4;
  const size = bits >>> 3;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = bitmap.offset + y * stride + x * size;
      const storage = bitmapStorage(bitmap, offset, size, true);
      const target = (y * width + x) * 4;
      if (bits === 16) {
        const value = storage.view.getUint16(offset, true);
        const red = (value >>> 10) & 31;
        const green = (value >>> 5) & 31;
        const blue = value & 31;
        output[target] = (red << 3) | (red >>> 2);
        output[target + 1] = (green << 3) | (green >>> 2);
        output[target + 2] = (blue << 3) | (blue >>> 2);
      } else {
        output[target] = storage.bytes[offset + 2]!;
        output[target + 1] = storage.bytes[offset + 1]!;
        output[target + 2] = storage.bytes[offset]!;
      }
      // BI_RGB ignores the fourth source byte, including native format-two alpha.
      output[target + 3] = 255;
    }
  return output;
}

/** Concrete browser DC for the native auxiliary windows; no game image is bundled here. */
export function presentAokanaChildBitmap(
  canvas: HTMLCanvasElement,
  bitmap: AokanaBitmap,
  x = 0,
  y = 0,
): void {
  const pixels = aokanaChildDibPixels(bitmap);
  if (pixels === null) return;
  const context = canvas.getContext('2d');
  if (context === null)
    throw new Error('Aokana child window cannot acquire its browser drawing context');
  context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), x | 0, y | 0);
}
