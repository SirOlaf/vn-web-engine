import {intersectRect, type Rect} from '../graphics/surface.js';
import {BrowserRasterText} from './browser-raster-text.js';
import type {RasterTextGlyph} from './raster-text.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../platform/runtime-performance.js';
import {subscribeDomTextStyle} from './dom-text-style.js';

export type BrowserTextMode = 'native' | 'dom';
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
  /** Text of the canvas's own pixels, or of `backdrop` when one is retained. */
  glyphs(): readonly RasterTextGlyph[];
  /** Null while the canvas itself presents the textless pixels in DOM mode. */
  backdrop: ImageData | null;
  patches: RetainedPatch[];
  overlay?: BrowserRasterText;
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
    const clipped = intersectRect(rect(glyph.clip), clip);
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
    const hit = intersectRect(glyph.clip, region);
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

/**
 * One presentation owner coordinates DOM text for canvases. A producer that can redraw its whole
 * canvas (the display device) presents the textless pixels itself in DOM mode and supplies only
 * glyphs through `replace`; mode changes ask it to redraw. Direct writes that cannot be redrawn
 * (GDI blits) keep native pixels on the canvas and retain lazy textless recipes instead, which
 * DOM mode composes over a snapshot of the canvas. Native mode never rasterizes an alternate.
 */
export class BrowserRasterTextPresentation {
  private readonly presentations = new Map<HTMLCanvasElement, Presentation>();
  private readonly redraws = new Map<HTMLCanvasElement, Set<() => void>>();
  private mode: BrowserTextMode = 'native';
  private readonly unsubscribeStyle = subscribeDomTextStyle(() => {
    if (this.mode === 'dom')
      for (const [canvas, value] of this.presentations) this.render(canvas, value);
  });
  get textMode(): BrowserTextMode {
    return this.mode;
  }
  setTextMode(mode: BrowserTextMode): void {
    if (mode !== 'native' && mode !== 'dom') throw new TypeError('Unknown text rendering mode');
    if (mode === this.mode) return;
    this.mode = mode;
    for (const [canvas, value] of this.presentations) this.render(canvas, value);
    for (const redraws of this.redraws.values()) for (const redraw of redraws) redraw();
  }
  /** `redraw` presents the canvas again in the current mode; returns the unsubscriber. */
  onTextModeChange(canvas: HTMLCanvasElement, redraw: () => void): () => void {
    const redraws = this.redraws.get(canvas) ?? new Set();
    redraws.add(redraw);
    this.redraws.set(canvas, redraws);
    return () => {
      redraws.delete(redraw);
      if (redraws.size === 0) this.redraws.delete(canvas);
    };
  }
  /** The canvas was redrawn whole, with textless pixels in DOM mode; `glyphs` is its text. */
  replace(canvas: HTMLCanvasElement, glyphs: () => readonly RasterTextGlyph[]): void {
    const previous = this.presentations.get(canvas);
    let cached: readonly RasterTextGlyph[] | undefined;
    const value: Presentation = {
      width: canvas.width,
      height: canvas.height,
      glyphs: () => (cached ??= glyphs()),
      backdrop: null,
      patches: [],
      overlay: previous?.overlay,
    };
    this.presentations.set(canvas, value);
    this.render(canvas, value);
  }
  /** Called after a native opaque blit. Its destination rectangle replaces prior text too. */
  paint(canvas: HTMLCanvasElement, patch: Patch): void {
    let value = this.presentations.get(canvas);
    const snapshot = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    if (!value || value.width !== canvas.width || value.height !== canvas.height) {
      value?.overlay?.dispose();
      value = {
        width: canvas.width,
        height: canvas.height,
        glyphs: () => [],
        backdrop: snapshot(),
        patches: [],
      };
      this.presentations.set(canvas, value);
    }
    const r = patch.region;
    if (r.x <= 0 && r.y <= 0 && r.x + r.width >= canvas.width && r.y + r.height >= canvas.height) {
      value.backdrop = snapshot();
      value.glyphs = () => [];
      value.patches = [];
    } else {
      // The canvas holds the producer's pixels and this blit's native ones, which its recipe
      // covers. The producer's text stays retained with that snapshot.
      value.backdrop ??= snapshot();
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
    recordRuntimeMetric('text.presentation.dom-mode', this.mode === 'dom' ? 1 : 0);
    if (this.mode === 'native') {
      value.overlay?.hide();
      return;
    }
    if (!canvas.parentElement || !value.width || !value.height) return;
    const finishDom = beginRuntimeSpan('text.presentation.dom');
    try {
      let frame = value.backdrop,
        glyphs = value.glyphs();
      if (frame !== null && value.patches.length) {
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
          const rendered = glyphs;
          value.backdrop = frame;
          value.glyphs = () => rendered;
          value.patches = [];
        }
      }
      const finishOverlay = beginRuntimeSpan('text.presentation.overlay');
      try {
        value.overlay ??= new BrowserRasterText(canvas);
        value.overlay.show(frame, glyphs, value.width, value.height);
      } finally {
        finishOverlay?.({glyphs: glyphs.length});
      }
    } finally {
      finishDom?.({width: value.width, height: value.height});
    }
  }
  clear(canvas: HTMLCanvasElement): void {
    this.presentations.get(canvas)?.overlay?.dispose();
    this.presentations.delete(canvas);
  }
  dispose(): void {
    this.unsubscribeStyle();
    this.redraws.clear();
    for (const canvas of this.presentations.keys()) this.clear(canvas);
  }
}
