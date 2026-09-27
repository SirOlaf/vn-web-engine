import type {RScriptRect, RScriptSurface} from '../graphics/pixels.js';
import type {RScriptPresenter} from '../runtime/display.js';
import type {GlyphCoverage, GlyphRasterizer} from '../runtime/text-block.js';

/** Presents native frames on a 2D canvas the size of the game screen. */
export class CanvasPresenter implements RScriptPresenter {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private shifted = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('A 2D canvas is required');
    this.context = context;
    this.image = context.createImageData(canvas.width, canvas.height);
  }

  present(frame: RScriptSurface, rect: RScriptRect, offsetX: number, offsetY: number): void {
    const {width, height} = this.image;
    const shifted = offsetX !== 0 || offsetY !== 0;
    // A shake presents the whole frame; the first unshifted frame after it does too.
    const area =
      shifted || this.shifted
        ? {
            left: 0,
            top: 0,
            right: Math.min(width, frame.width),
            bottom: Math.min(height, frame.height),
          }
        : rect;
    const out = this.image.data,
      source = frame.data;
    for (let y = area.top; y < area.bottom; y++) {
      let i = y * frame.width + area.left,
        o = (y * width + area.left) * 4;
      for (let x = area.left; x < area.right; x++, i++, o += 4) {
        const pixel = source[i]!;
        out[o] = (pixel >>> 16) & 0xff;
        out[o + 1] = (pixel >>> 8) & 0xff;
        out[o + 2] = pixel & 0xff;
        out[o + 3] = 255;
      }
    }
    if (shifted) {
      this.context.fillStyle = '#000';
      this.context.fillRect(0, 0, width, height);
      this.context.putImageData(this.image, offsetX, offsetY);
    } else
      this.context.putImageData(
        this.image,
        0,
        0,
        area.left,
        area.top,
        area.right - area.left,
        area.bottom - area.top,
      );
    this.shifted = shifted;
  }

  fill(colorref: number): void {
    const r = colorref & 0xff,
      g = (colorref >>> 8) & 0xff,
      b = (colorref >>> 16) & 0xff;
    this.context.fillStyle = `rgb(${r} ${g} ${b})`;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.shifted = true;
  }
}

/** Font families tried for the executable's font, with common Japanese fallbacks. */
export function rscriptFontFamilies(nativeName: string): string {
  const names = [
    nativeName,
    'MS Gothic',
    'ＭＳ ゴシック',
    'Noto Sans JP',
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
  ];
  return (
    [...new Set(names.filter(Boolean))].map((name) => JSON.stringify(name)).join(', ') +
    ', sans-serif'
  );
}

/**
 * GetGlyphOutline(GGO_GRAY8) replacement: draws one Shift-JIS character with the browser's
 * font rasterizer into a `size`-high cell (half width for single-byte codes) and returns
 * coverage in 65 levels.
 */
export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private readonly context: CanvasRenderingContext2D;
  private readonly decoder = new TextDecoder('shift-jis');
  private readonly cache = new Map<string, GlyphCoverage>();

  constructor(
    private readonly families: string,
    document: Document,
  ) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw new Error('A 2D canvas is required for text');
    this.context = context;
  }

  /** The native font code ignores the face index; every face uses the executable font. */
  rasterize(
    code: number,
    size: number,
    _face: number,
    bold: boolean,
    italic: boolean,
  ): GlyphCoverage {
    const key = `${code}:${size}:${bold ? 1 : 0}${italic ? 1 : 0}`;
    let glyph = this.cache.get(key);
    if (!glyph) {
      glyph = this.draw(code, size, bold, italic);
      if (this.cache.size > 8192) this.cache.clear();
      this.cache.set(key, glyph);
    }
    return glyph;
  }

  private draw(code: number, size: number, bold: boolean, italic: boolean): GlyphCoverage {
    const width = code > 0xff ? size : size >> 1,
      height = size;
    const levels = new Uint8Array(width * height);
    if (!width || !height) return {width, height, levels};
    const bytes = code > 0xff ? Uint8Array.of(code >>> 8, code & 0xff) : Uint8Array.of(code);
    const text = this.decoder.decode(bytes);
    const context = this.context;
    const canvas = context.canvas;
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${this.families}`;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#fff';
    const measured = context.measureText(text).width;
    // Keep proportional fallback fonts inside the fixed native cell.
    if (measured > width) context.setTransform(width / measured, 0, 0, 1, 0, 0);
    else context.translate(Math.round((width - measured) / 2), 0);
    context.fillText(text, 0, Math.round(size * 0.86));
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let i = 0; i < levels.length; i++) levels[i] = Math.round((pixels[i * 4 + 3]! * 64) / 255);
    return {width, height, levels};
  }
}
