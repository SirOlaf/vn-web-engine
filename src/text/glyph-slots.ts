import type {TriangleImage} from '../graphics/triangle-draw.js';
import type {Rect} from '../graphics/surface.js';
/** Presentation data only. Engine adapters own decoding, ordering and line numbers. */
export interface GlyphRaster {
  texture: number;
  source: Rect;
  image?: TriangleImage;
  alphaOnly?: boolean;
}
export interface TextShadow {
  x: number;
  y: number;
  color: number;
  alpha: number;
}
/** A native text edge painted beneath the glyph. */
export interface TextOutline {
  radiusX: number;
  radiusY: number;
  color: number;
  alpha: number;
  /**
   * Coverage weights summed per edge pixel and clamped to full coverage, row-major over
   * (2 * radiusY + 1) rows of (2 * radiusX + 1) pixel offsets. Without weights the edge
   * is the glyph dilated by the radii.
   */
  weights?: readonly number[];
}
export interface TextGlyph extends Rect {
  id: number;
  /** Presentation flow identity keeps neighboring controls outside body text. */
  flow?: string;
  /** Font size can differ from the transformed/cropped raster cell's height. */
  size?: number;
  text: string | undefined;
  line: number;
  color: number;
  alpha: number;
  clip?: Rect;
  raster?: GlyphRaster;
  shadows?: readonly TextShadow[];
  outline?: TextOutline;
}
export interface GlyphSlot {
  interactive?: boolean;
  /** Use explicit native row boundaries; browser width must not invent wrapping. */
  explicitLines?: boolean;
  vertical?: boolean;
  bold?: boolean;
  /** CSS font weight; overrides `bold`. */
  weight?: number;
  /**
   * Native glyph width relative to the font size. When set, browser glyphs use this
   * horizontal scale and letter spacing reproduces the native advances.
   */
  stretch?: number;
  id: string;
  glyphs: readonly TextGlyph[];
}
export interface SlotText {
  text: string;
  visualText: string;
  bounds: Rect;
  clip: Rect;
  size: number;
  color: number;
  alpha: number;
  lines: number;
  shadows: readonly TextShadow[];
  outline?: TextOutline;
}
/** A complete glyph buffer keeps unrevealed suffixes from changing the slot's bounds. */
export function slotText(slot: GlyphSlot): SlotText | undefined {
  const all = slot.glyphs;
  if (!all.length) return;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity,
    size = 0,
    lastLine = 0,
    firstLine = Infinity;
  for (const g of all) {
    left = Math.min(left, g.x);
    top = Math.min(top, g.y);
    right = Math.max(right, g.x + g.width);
    bottom = Math.max(bottom, g.y + g.height);
    size = Math.max(size, g.size ?? g.height);
    lastLine = Math.max(lastLine, g.line);
    firstLine = Math.min(firstLine, g.line);
  }
  if (!(right > left && bottom > top && size > 0)) return;
  const visible = all.filter(
    (g) => g.alpha > 0 && (!g.clip || (g.clip.width > 0 && g.clip.height > 0)),
  );
  if (!visible.length) return;
  const lines = Array.from({length: lastLine - firstLine + 1}, () => ''),
    lastVisible = all.lastIndexOf(visible.at(-1)!);
  for (let i = 0; i <= lastVisible; i++) {
    const g = all[i]!;
    lines[g.line - firstLine] +=
      (g.alpha > 0 ? g.text : ' '.repeat(Array.from(g.text ?? '').length)) ?? '';
  }
  const shadows = visible[0]!.shadows ?? [],
    outline = visible[0]!.outline,
    edgeX = outline?.radiusX ?? 0,
    edgeY = outline?.radiusY ?? 0;
  const minX = Math.min(0, ...shadows.map((s) => s.x)) - edgeX,
    minY = Math.min(0, ...shadows.map((s) => s.y)) - edgeY,
    maxX = Math.max(0, ...shadows.map((s) => s.x)) + edgeX,
    maxY = Math.max(0, ...shadows.map((s) => s.y)) + edgeY;
  let clip = {
    x: left + minX,
    y: top + minY,
    width: right - left + maxX - minX,
    height: bottom - top + maxY - minY,
  };
  const clipped = all.filter((g) => g.clip);
  if (clipped.length) {
    const x = Math.min(...clipped.map((g) => g.clip!.x)),
      y = Math.min(...clipped.map((g) => g.clip!.y)),
      r = Math.max(...clipped.map((g) => g.clip!.x + g.clip!.width)),
      b = Math.max(...clipped.map((g) => g.clip!.y + g.clip!.height));
    // Glyph clips cover the cell only; the outline's dilation extends past it.
    clip = {x: x - edgeX, y: y - edgeY, width: r - x + 2 * edgeX, height: b - y + 2 * edgeY};
  }
  return {
    text: lines.join(''),
    visualText: lines.slice(0, visible.at(-1)!.line - firstLine + 1).join('\n'),
    bounds: {x: left, y: top, width: right - left, height: bottom - top},
    clip,
    size,
    color: visible[0]!.color,
    alpha: Math.max(...visible.map((g) => g.alpha)),
    lines: lines.length,
    shadows,
    ...(outline ? {outline} : {}),
  };
}
