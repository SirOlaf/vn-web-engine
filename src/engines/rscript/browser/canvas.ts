import {decodeCp932} from '../../../text/cp932.js';
import type {RScriptRect, RScriptSurface} from '../graphics/pixels.js';
import type {RScriptPresenter} from '../runtime/display.js';
import {gdiVerticalCell, gdiVerticalForms} from '../../../text/gdi-vertical-forms.js';
import {DEFAULT_FACES, type GlyphCoverage, type GlyphRasterizer} from '../runtime/text-block.js';

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

/** CSS font families for a native face name, with common Japanese fallbacks. */
export function rscriptFontFamilies(nativeName: string): string {
  const serif = /明朝|mincho/i.test(nativeName);
  const names = serif
    ? [nativeName, 'MS Mincho', 'ＭＳ 明朝', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho']
    : [
        nativeName,
        'MS Gothic',
        'ＭＳ ゴシック',
        'Noto Sans JP',
        'Hiragino Kaku Gothic ProN',
        'Yu Gothic',
      ];
  return (
    [...new Set(names.filter(Boolean))].map((name) => JSON.stringify(name)).join(', ') +
    (serif ? ', serif' : ', sans-serif')
  );
}

/** Glyphs are drawn at up to 8 times their size, and at most 512 pixels high. */
const SUPERSAMPLE = 8;
const SUPERSAMPLE_LIMIT = 512;
/** Canvas size at which a face's metrics are measured. */
const PROBE_SIZE = 256;

/** A face as CreateFont sees it: `size` is the cell height, ascent plus descent. */
interface CanvasFace {
  readonly families: string;
  /** Which vertical alternates the face's `@` variant has. */
  readonly design: 'mincho' | 'gothic';
  /** CSS font size per pixel of cell height. */
  readonly em: number;
  /** The ascent's share of the cell (tmAscent / tmHeight). */
  readonly ascent: number;
}

/**
 * GetGlyphOutline(GGO_GRAY8) replacement: draws one Shift-JIS character with the browser's
 * font rasterizer into a `size`-high cell (half width for single-byte codes) and returns
 * coverage in 65 levels.
 */
export class CanvasGlyphRasterizer implements GlyphRasterizer {
  private readonly context: CanvasRenderingContext2D;
  private readonly cache = new Map<string, GlyphCoverage>();
  private readonly faces: CanvasFace[] = [];
  /** Faces by name, so the per-page font window faces keep their glyphs. */
  private readonly known = new Map<string, CanvasFace>();

  constructor(document: Document) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw new Error('A 2D canvas is required for text');
    this.context = context;
    for (const name of DEFAULT_FACES) this.addFace(name);
  }

  /** CSS families of a face, for text that should match the glyphs. */
  families(face: number): string {
    return (this.faces[face] ?? this.faces[0]!).families;
  }

  addFace(name: string): number {
    this.faces.push(this.face(name));
    return this.faces.length - 1;
  }
  setFace(face: number, name: string): void {
    if (face >= 0 && face < this.faces.length) this.faces[face] = this.face(name);
  }
  removeFace(): void {
    this.faces.pop();
  }

  /**
   * CreateFont with a positive height scales the font so its Windows ascent and descent fill
   * the cell, and tmAscent is the ascent's share of it. Browsers report those metrics as the
   * font bounding box.
   */
  private face(name: string): CanvasFace {
    let face = this.known.get(name);
    if (face) return face;
    const families = rscriptFontFamilies(name),
      design = gdiVerticalForms(name);
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.font = `${PROBE_SIZE}px ${families}`;
    const metrics = context.measureText('あ');
    const above = metrics.fontBoundingBoxAscent,
      below = metrics.fontBoundingBoxDescent;
    const cell = above + below;
    face =
      Number.isFinite(cell) && cell > 0
        ? {families, design, em: PROBE_SIZE / cell, ascent: above / cell}
        : // MS Gothic's winAscent and winDescent are 220 and 36 of 256 units.
          {families, design, em: 1, ascent: 220 / 256};
    this.known.set(name, face);
    return face;
  }

  rasterize(
    code: number,
    size: number,
    faceIndex: number,
    bold: boolean,
    italic: boolean,
    vertical = false,
  ): GlyphCoverage {
    const face = this.faces[faceIndex] ?? this.faces[0]!;
    const key = `${face.families}:${code}:${size}:${bold ? 1 : 0}${italic ? 1 : 0}${vertical ? 'v' : ''}`;
    let glyph = this.cache.get(key);
    if (!glyph) {
      if (vertical) {
        const horizontal = this.rasterize(code, size, faceIndex, bold, italic);
        const bytes = code > 0xff ? Uint8Array.of(code >>> 8, code & 0xff) : Uint8Array.of(code);
        glyph = gdiVerticalCell(decodeCp932(bytes), horizontal, face.design);
      } else glyph = this.draw(face, code, size, bold, italic);
      if (this.cache.size > 8192) this.cache.clear();
      this.cache.set(key, glyph);
    }
    return glyph;
  }

  /**
   * GetGlyphOutline rasterizes the outline, but browsers draw small sizes of fonts such as
   * MS Gothic from their embedded bitmaps, which are thin and aliased. Drawing at a
   * multiple of the size, where no bitmap strike exists, and averaging the blocks gives
   * coverage close to GGO_GRAY8.
   */
  private draw(
    face: CanvasFace,
    code: number,
    size: number,
    bold: boolean,
    italic: boolean,
  ): GlyphCoverage {
    const width = code > 0xff ? size : size >> 1,
      height = size;
    const levels = new Uint8Array(width * height);
    // GDI rounds tmAscent to whole pixels.
    const ascent = Math.round(size * face.ascent);
    if (!width || !height) return {width, height, levels, ascent};
    const scale = Math.max(1, Math.min(SUPERSAMPLE, Math.floor(SUPERSAMPLE_LIMIT / size)));
    const bytes = code > 0xff ? Uint8Array.of(code >>> 8, code & 0xff) : Uint8Array.of(code);
    const text = decodeCp932(bytes);
    const context = this.context;
    const canvas = context.canvas;
    const w = width * scale,
      h = height * scale;
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, w, h);
    context.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size * face.em * scale}px ${face.families}`;
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#fff';
    const measured = context.measureText(text).width / scale;
    // Keep proportional fallback fonts inside the fixed native cell; narrower glyphs start
    // at the pen position, as GDI draws them.
    if (measured > width) context.setTransform(width / measured, 0, 0, 1, 0, 0);
    context.fillText(text, 0, ascent * scale);
    const pixels = context.getImageData(0, 0, w, h).data;
    const full = 255 * scale * scale;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let j = 0; j < scale; j++) {
          const row = ((y * scale + j) * w + x * scale) * 4 + 3;
          for (let i = 0; i < scale; i++) sum += pixels[row + i * 4]!;
        }
        levels[y * width + x] = Math.round((sum * 64) / full);
      }
    return {width, height, levels, ascent};
  }
}
