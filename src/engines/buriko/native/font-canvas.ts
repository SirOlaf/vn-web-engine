/** Canvas state shared by main-thread and worker glyph rasterization. */
export interface BurikoFontCanvasStyle {
  /** CSS font shorthand resolved by the face's metrics context. */
  readonly font: string;
  readonly horizontalScale: number;
  readonly ascent: number;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function burikoFontCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D {
  if (width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new RangeError('Buriko font raster dimensions are invalid');
  const canvas = new OffscreenCanvas(width, height);
  const result = canvas.getContext('2d', {willReadFrequently: true});
  if (!result) throw new Error('Buriko browser font raster context is unavailable');
  return result;
}

export function configureBurikoFontCanvas(
  target: OffscreenCanvasRenderingContext2D,
  style: BurikoFontCanvasStyle,
): void {
  target.font = style.font;
  target.fontKerning = 'none';
  target.textBaseline = 'alphabetic';
  target.fillStyle = '#000';
  target.scale(style.horizontalScale, 1);
}

/**
 * Reuses one configured context per DIB size. Assigning `font` to a fresh context and
 * resolving it on first draw cost more than the draw itself.
 */
export class BurikoFontTextCanvas {
  private target: OffscreenCanvasRenderingContext2D | null = null;
  constructor(readonly style: BurikoFontCanvasStyle) {}
  /** Native NONANTIALIASED_QUALITY DIB: alpha >= 128 is ink, stored as 255, rows 4-aligned. */
  raster(text: string, width: number, height: number): {bytes: Uint8Array; stride: number} {
    let target = this.target;
    if (target === null || target.canvas.width !== width || target.canvas.height !== height) {
      target = this.target = burikoFontCanvas(width, height);
      configureBurikoFontCanvas(target, this.style);
    } else {
      // Clear in device space: the configured horizontal scale can be below 1.
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, width, height);
      target.setTransform(this.style.horizontalScale, 0, 0, 1, 0, 0);
    }
    target.fillText(text, 0, this.style.ascent);
    const rgba = target.getImageData(0, 0, width, height).data;
    const stride = Math.ceil(width / 4) * 4;
    const bytes = new Uint8Array(stride * height);
    if (littleEndian && (rgba.byteOffset & 3) === 0) {
      // Alpha is each word's top byte, so alpha >= 128 is exactly the sign bit.
      const words = new Int32Array(rgba.buffer, rgba.byteOffset, width * height);
      for (let y = 0; y < height; y++)
        for (let x = 0, row = y * width, out = y * stride; x < width; x++)
          bytes[out + x] = words[row + x]! >> 31;
    } else
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          bytes[y * stride + x] = rgba[(y * width + x) * 4 + 3]! >= 128 ? 255 : 0;
    return {bytes, stride};
  }
}
