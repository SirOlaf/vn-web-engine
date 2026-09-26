import type {Rect} from '../graphics/surface.js';
import {BrowserRasterText} from './browser-raster-text.js';
import type {RasterTextGlyph} from './raster-text.js';

export type BrowserTextMode = 'native' | 'dom';
export interface BrowserRasterTextFrame {
  frame: ImageData;
  glyphs: readonly RasterTextGlyph[];
}
interface Patch {
  paint(context: CanvasRenderingContext2D): void;
  glyphs: readonly RasterTextGlyph[];
  region: Rect;
}
interface RetainedPatch extends Patch {
  remaining: Rect[];
}
interface Presentation {
  width: number;
  height: number;
  base(): BrowserRasterTextFrame;
  patches: RetainedPatch[];
  overlay?: BrowserRasterText;
}

export function intersectTextRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? {x, y, width, height} : null;
}

/** Map glyph geometry separately from the native pixels, with the same destination clip. */
export function mapRasterTextGlyphs(
  glyphs: readonly RasterTextGlyph[],
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  clip: Rect,
): RasterTextGlyph[] {
  const rect = (r: Rect): Rect => ({
    x: x + r.x * scaleX,
    y: y + r.y * scaleY,
    width: r.width * scaleX,
    height: r.height * scaleY,
  });
  return glyphs.flatMap((glyph) => {
    const clipped = intersectTextRect(rect(glyph.clip), clip);
    return clipped
      ? [{...glyph, ...rect(glyph), clip: clipped, size: glyph.size * Math.abs(scaleY)}]
      : [];
  });
}

export function rasterTextOutsideRegion(
  glyphs: readonly RasterTextGlyph[],
  region: Rect,
): RasterTextGlyph[] {
  return glyphs.flatMap((glyph) => {
    const hit = intersectTextRect(glyph.clip, region);
    if (!hit) return [glyph];
    const c = glyph.clip;
    return [
      {x: c.x, y: c.y, width: c.width, height: hit.y - c.y},
      {x: c.x, y: hit.y + hit.height, width: c.width, height: c.y + c.height - hit.y - hit.height},
      {x: c.x, y: hit.y, width: hit.x - c.x, height: hit.height},
      {
        x: hit.x + hit.width,
        y: hit.y,
        width: c.x + c.width - hit.x - hit.width,
        height: hit.height,
      },
    ]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((clip) => ({...glyph, clip}));
  });
}

/** One presentation owner coordinates full frames and direct DC writes to the same canvas.
 * Native mode retains lazy recipes only; it never creates or rasterizes an alternate frame.
 */
export class BrowserRasterTextPresentation {
  private readonly presentations = new Map<HTMLCanvasElement, Presentation>();
  private mode: BrowserTextMode = 'native';
  get textMode(): BrowserTextMode {
    return this.mode;
  }
  setTextMode(mode: BrowserTextMode): void {
    if (mode !== 'native' && mode !== 'dom') throw new TypeError('Unknown text rendering mode');
    this.mode = mode;
    for (const [canvas, value] of this.presentations) this.render(canvas, value);
  }
  replace(canvas: HTMLCanvasElement, base: () => BrowserRasterTextFrame): void {
    const previous = this.presentations.get(canvas);
    const value = {
      width: canvas.width,
      height: canvas.height,
      base,
      patches: [],
      overlay: previous?.overlay,
    };
    this.presentations.set(canvas, value);
    this.render(canvas, value);
  }
  /** Called after a native opaque blit. Its destination rectangle replaces prior text too. */
  paint(canvas: HTMLCanvasElement, patch: Patch): void {
    let value = this.presentations.get(canvas);
    if (!value || value.width !== canvas.width || value.height !== canvas.height) {
      value?.overlay?.dispose();
      const frame = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      value = {
        width: canvas.width,
        height: canvas.height,
        base: () => ({frame, glyphs: []}),
        patches: [],
      };
      this.presentations.set(canvas, value);
    }
    const r = patch.region;
    if (r.x <= 0 && r.y <= 0 && r.x + r.width >= canvas.width && r.y + r.height >= canvas.height) {
      const frame = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      value.base = () => ({frame, glyphs: []});
      value.patches = [];
    } else {
      // Retire a source after any combination of later opaque writes covers it.
      // This also bounds native-mode recipes without rendering an alternate frame.
      for (const old of value.patches)
        old.remaining = old.remaining.flatMap((clip) => {
          const glyph = {clip} as RasterTextGlyph;
          return rasterTextOutsideRegion([glyph], r).map((g) => g.clip);
        });
      value.patches = value.patches.filter((old) => old.remaining.length !== 0);
    }
    value.patches.push({...patch, remaining: [r]});
    this.render(canvas, value);
  }
  private render(canvas: HTMLCanvasElement, value: Presentation): void {
    if (this.mode === 'native') {
      value.overlay?.hide();
      return;
    }
    if (!canvas.parentElement || !value.width || !value.height) return;
    let {frame, glyphs} = value.base();
    if (value.patches.length) {
      const scratch = canvas.ownerDocument.createElement('canvas');
      scratch.width = value.width;
      scratch.height = value.height;
      const context = scratch.getContext('2d')!;
      context.putImageData(frame, 0, 0);
      for (const patch of value.patches) {
        context.save();
        patch.paint(context);
        context.restore();
        glyphs = [...rasterTextOutsideRegion(glyphs, patch.region), ...patch.glyphs];
      }
      frame = context.getImageData(0, 0, value.width, value.height);
      if (value.patches.length >= 64) {
        const rendered = {frame, glyphs};
        value.base = () => rendered;
        value.patches = [];
      }
    }
    value.overlay ??= new BrowserRasterText(canvas);
    value.overlay.show(frame, glyphs);
  }
  clear(canvas: HTMLCanvasElement): void {
    this.presentations.get(canvas)?.overlay?.dispose();
    this.presentations.delete(canvas);
  }
  dispose(): void {
    for (const canvas of this.presentations.keys()) this.clear(canvas);
  }
}
