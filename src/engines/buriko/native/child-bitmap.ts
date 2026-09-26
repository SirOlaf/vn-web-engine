import {burikoBitmapPixelSize, bitmapStorage, type BurikoBitmap} from './bitmap.js';
import {rasterTextBitmap, visibleRasterText} from '../../../text/raster-text.js';
import {
  BrowserRasterTextPresentation,
  intersectTextRect,
  mapRasterTextGlyphs,
} from '../../../text/browser-raster-text-presentation.js';
import {invalidateCanvasFrame} from '../../../graphics/canvas-frame-presenter.js';

/** 1400b7390's untransformed StretchDIBits input used by every auxiliary-window caller. */
export function burikoChildDibPixels(bitmap: BurikoBitmap): Uint8ClampedArray<ArrayBuffer> | null {
  const bits = burikoBitmapPixelSize(bitmap.format) << 3;
  // BI_RGB has no 48-bit DIB interpretation; StretchDIBits fails without changing the DC.
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;
  if (bits === 8)
    throw new Error('Buriko child DIB reads the native uninitialized eight-bit color table');
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

/** Snapshot only presentation backing; a deferred mode switch must survive native buffer reuse. */
export function captureBurikoChildText(
  bitmap: BurikoBitmap,
  nativePixels: Uint8ClampedArray<ArrayBuffer>,
) {
  const width = bitmap.width,
    height = bitmap.height;
  const glyphs = visibleRasterText(bitmap);
  const alternate = rasterTextBitmap(bitmap);
  const snapshot =
    alternate.storage === bitmap.storage
      ? null
      : {
          ...alternate,
          storage: alternate.storage?.cloneRange(0, alternate.storage.bytes.length) ?? null,
        };
  let frame: ImageData | undefined;
  return {
    glyphs,
    frame: (): ImageData =>
      (frame ??= new ImageData(
        snapshot ? burikoChildDibPixels(snapshot)! : nativePixels,
        width,
        height,
      )),
  };
}

/** Concrete browser DC for the native auxiliary windows; no game image is bundled here. */
export function presentBurikoChildBitmap(
  canvas: HTMLCanvasElement,
  bitmap: BurikoBitmap,
  x = 0,
  y = 0,
  textPresentation: BrowserRasterTextPresentation | null = null,
): void {
  const pixels = burikoChildDibPixels(bitmap);
  if (pixels === null) return;
  const context = canvas.getContext('2d');
  if (context === null)
    throw new Error('Buriko child window cannot acquire its browser drawing context');
  context.putImageData(new ImageData(pixels, bitmap.width, bitmap.height), x | 0, y | 0);
  invalidateCanvasFrame(canvas);
  if (textPresentation !== null) {
    x |= 0;
    y |= 0;
    const region = intersectTextRect(
      {x, y, width: bitmap.width, height: bitmap.height},
      {x: 0, y: 0, width: canvas.width, height: canvas.height},
    );
    if (region) {
      const captured = captureBurikoChildText(bitmap, pixels);
      textPresentation.paint(canvas, {
        region,
        glyphs: mapRasterTextGlyphs(captured.glyphs, x, y, 1, 1, region),
        paint: (context) => context.putImageData(captured.frame(), x, y),
      });
    }
  }
}
