import {Surface} from './surface.js';
import type {Rect} from './surface.js';
/** Crop only requested glyphs; large atlases need not become compositor targets. */
export class BitmapFont {
  private readonly cache = new Map<string, Surface>();
  constructor(readonly image: {width: number; height: number; pixels: Uint8Array}) {
    if (
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      image.pixels.length !== image.width * image.height * 4
    )
      throw new Error('Invalid bitmap font image');
  }
  glyph(rect: Rect): Surface {
    const {x, y, width, height} = rect,
      key = [x, y, width, height].join('/');
    if (
      ![x, y, width, height].every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1 ||
      x + width > this.image.width ||
      y + height > this.image.height
    )
      throw new Error('Glyph outside atlas');
    let glyph = this.cache.get(key);
    if (glyph) return glyph;
    const bytes = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++)
      bytes.set(
        this.image.pixels.subarray(
          ((y + row) * this.image.width + x) * 4,
          ((y + row) * this.image.width + x + width) * 4,
        ),
        row * width * 4,
      );
    glyph = new Surface(width, height);
    glyph.uploadStraight(bytes);
    this.cache.set(key, glyph);
    return glyph;
  }
  dispose(): void {
    for (const glyph of this.cache.values()) glyph.dispose();
    this.cache.clear();
  }
}
