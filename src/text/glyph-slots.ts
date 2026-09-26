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
export interface TextGlyph extends Rect {
  id: number;
  text: string | undefined;
  line: number;
  color: number;
  alpha: number;
  clip?: Rect;
  raster?: GlyphRaster;
  shadows?: readonly TextShadow[];
}
export interface GlyphSlot {
  interactive?: boolean;
  vertical?: boolean;
  bold?: boolean;
  id: string;
  glyphs: readonly TextGlyph[];
}
export interface SlotText {
  text: string;
  bounds: Rect;
  clip: Rect;
  size: number;
  color: number;
  alpha: number;
  lines: number;
  shadows: readonly TextShadow[];
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
    size = Math.max(size, g.height);
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
  const shadows = visible[0]!.shadows ?? [];
  const minX = Math.min(0, ...shadows.map((s) => s.x)),
    minY = Math.min(0, ...shadows.map((s) => s.y)),
    maxX = Math.max(0, ...shadows.map((s) => s.x)),
    maxY = Math.max(0, ...shadows.map((s) => s.y));
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
    clip = {x, y, width: r - x, height: b - y};
  }
  return {
    text: lines.join(''),
    bounds: {x: left, y: top, width: right - left, height: bottom - top},
    clip,
    size,
    color: visible[0]!.color,
    alpha: Math.max(...visible.map((g) => g.alpha)),
    lines: lines.length,
    shadows,
  };
}
