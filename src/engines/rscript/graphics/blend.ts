import {
  ADD_TABLE,
  DEL_TABLE,
  mixRgb,
  saturatingAdd,
  scaleRgb,
  type RScriptRect,
  type RScriptSurface,
} from './pixels.js';

/** Sprite drawing state read by the native blitters (sprite +40, +44, +48, +52, +56). */
export interface BlendState {
  /** Blend mode (vtable +176). */
  mode: number;
  /** Global level 0..255 (vtable +180); 255 is fully faded for fade-type modes. */
  alpha: number;
  /** Transparency handling (vtable +184): 0 blend, 1 threshold, 2 soft wipe, 6 opaque. */
  mask: number;
  /** Threshold for mask modes (vtable +188). */
  maskLevel: number;
  /** Colour used by the additive glow mode 107. */
  color: number;
}

/** Four-by-four dissolve masks for blend mode 0x12, indexed by `alpha >> 4` (word_4820F0). */
const DISSOLVE_PATTERNS = [
  0xffdf, 0xefdf, 0x6fdf, 0x6fd7, 0x6bd7, 0x6bd6, 0x6b56, 0x6a56, 0x2a56, 0x2a52, 0x0a52, 0x0a12,
  0x0812, 0x0810, 0x0800, 0x0000,
];

/** GetEmbosTable (0x401630): darkening rows below 128, brightening rows from 128. */
function embossRow(value: number): {table: Uint8Array; row: number} {
  return value >= 0x80
    ? {table: DEL_TABLE, row: 2 * (value - 0x80) + 1}
    : {table: ADD_TABLE, row: 254 - 2 * value};
}

interface Span {
  /** Destination and source origins and the clipped size. */
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  width: number;
  height: number;
}

/** sub_4427D0: intersects the placed sprite with the clip and target bounds. */
export function clipSprite(
  target: RScriptSurface,
  source: RScriptSurface,
  x: number,
  y: number,
  clip: RScriptRect,
): Span | null {
  const left = Math.max(x, Math.max(clip.left, 0));
  const top = Math.max(y, Math.max(clip.top, 0));
  const right = Math.min(x + source.width, Math.min(clip.right, target.width));
  const bottom = Math.min(y + source.height, Math.min(clip.bottom, target.height));
  if (right <= left || bottom <= top) return null;
  return {dx: left, dy: top, sx: left - x, sy: top - y, width: right - left, height: bottom - top};
}

type Pixel = (src: number, dst: number, column: number, row: number) => number | undefined;

function eachPixel(target: RScriptSurface, source: RScriptSurface, span: Span, pixel: Pixel): void {
  const dst = target.data,
    src = source.data;
  for (let row = 0; row < span.height; row++) {
    let d = (span.dy + row) * target.width + span.dx;
    let s = (span.sy + row) * source.width + span.sx;
    for (let column = 0; column < span.width; column++, d++, s++) {
      const result = pixel(src[s]!, dst[d]!, column, row);
      if (result !== undefined) dst[d] = result;
    }
  }
}

function copyRows(
  target: RScriptSurface,
  source: RScriptSurface,
  span: Span,
  rows?: (row: number) => boolean,
): void {
  for (let row = 0; row < span.height; row++) {
    if (rows && !rows(row)) continue;
    const s = (span.sy + row) * source.width + span.sx;
    target.data.set(
      source.data.subarray(s, s + span.width),
      (span.dy + row) * target.width + span.dx,
    );
  }
}

/** Per-pixel blend with the source transparency byte (0x443FB0). */
function transparencyBlend(src: number, dst: number): number | undefined {
  const t = src >>> 24;
  if (t === 0xff) return undefined;
  return t ? mixRgb(src, dst, t) : src;
}

/**
 * Draws a sprite like the native dispatcher (0x4430B0). Blend modes without a case here
 * (5, 6, 7, 0x0B, 0x0C, 0x0F, 0x13, 0x16, 0x69, 0x6A) are not selected by the supported
 * titles; like unknown modes they draw nothing until a title needs them.
 */
export function blendSprite(
  target: RScriptSurface,
  source: RScriptSurface,
  x: number,
  y: number,
  clip: RScriptRect,
  state: BlendState,
): void {
  const span = clipSprite(target, source, x, y, clip);
  if (!span) return;
  const {mode, mask} = state;
  const alpha = state.alpha & 0xff;
  const threshold = state.maskLevel;
  switch (mode) {
    case 0:
      return blendNormal(target, source, span, mask, threshold);
    case 2:
      if (mask === 0)
        // 0x444BC0: the global level acts as a transparency floor.
        eachPixel(target, source, span, (src, dst) =>
          mixRgb(src, dst, Math.max(src >>> 24, alpha)),
        );
      else if (mask === 1)
        eachPixel(target, source, span, (src, dst) =>
          src >>> 24 < threshold ? mixRgb(src, dst, alpha) : undefined,
        );
      else eachPixel(target, source, span, (src, dst) => mixRgb(src, dst, alpha));
      return;
    case 3:
    case 4: {
      const table = mode === 3 ? ADD_TABLE : DEL_TABLE;
      if (mask === 1) return;
      if (mask === 0)
        eachPixel(target, source, span, (src, dst) =>
          mixRgb(scaleRgb(table, alpha, src), dst, src >>> 24),
        );
      else eachPixel(target, source, span, (src) => scaleRgb(table, alpha, src));
      return;
    }
    case 8:
      if (alpha < 5)
        return blendNormal(target, source, span, mask === 0 ? 0 : mask === 1 ? -1 : 6, threshold);
      if (mask === 1) return;
      eachPixel(target, source, span, (src, dst) => {
        const t = src >>> 24;
        if (mask !== 0 || t <= 0x80)
          return (((dst >>> 1) & 0x7f7f7f7f) + ((src >>> 1) & 0x7f7f7f7f)) >>> 0;
        return mixRgb(src, dst, t);
      });
      return;
    case 0x0d:
      if (mask !== 0) eachPixel(target, source, span, (src) => (src ^ 0xffffff) >>> 0);
      else
        eachPixel(target, source, span, (src, dst) =>
          mixRgb((src ^ 0xffffff) >>> 0, dst, src >>> 24),
        );
      return;
    case 0x0e:
      if (mask === 1) return;
      eachPixel(target, source, span, (src, dst) =>
        saturatingAdd(
          scaleRgb(ADD_TABLE, mask === 0 ? Math.max(src >>> 24, alpha) : alpha, src),
          dst,
        ),
      );
      return;
    case 0x12: {
      if (mask === 1) return;
      const pattern = DISSOLVE_PATTERNS[alpha >> 4]!;
      eachPixel(target, source, span, (src, dst, column, row) => {
        if (!(pattern & (1 << (4 * (row & 3) + (column & 3))))) return undefined;
        return mask === 0 ? mixRgb(src, dst, src >>> 24) : src;
      });
      return;
    }
    case 0x14:
    case 0x15: {
      if (mask === 1) return;
      const level = alpha >> 4;
      // Horizontal (0x14) or vertical (0x15) sixteen-line blinds.
      // 0x445CC0 also staggers the horizontal blinds diagonally when blending.
      const visible = (column: number, row: number): boolean =>
        mode === 0x14
          ? (row & 0xf) > level && (mask !== 0 || ((column + row) & 0xf) > level)
          : (column & 0xf) > level;
      if (mask !== 0 && mode === 0x14)
        return copyRows(target, source, span, (row) => (row & 0xf) > level);
      eachPixel(target, source, span, (src, dst, column, row) => {
        if (!visible(column, row)) return undefined;
        return mask === 0 ? mixRgb(src, dst, src >>> 24) : src;
      });
      return;
    }
    case 0x67:
      // 0x447D70: inverts the destination under opaque source pixels.
      eachPixel(target, source, span, (src, dst) =>
        src >>> 24 ? undefined : (dst ^ 0xffffff) >>> 0,
      );
      return;
    case 0x68:
      // 0x447E70: each source channel selects an emboss row for the destination channel.
      eachPixel(target, source, span, (src, dst) => {
        let out = dst & 0xff000000;
        for (let shift = 0; shift < 24; shift += 8) {
          const {table, row} = embossRow((src >>> shift) & 0xff);
          out |= table[(row << 8) | ((dst >>> shift) & 0xff)]! << shift;
        }
        return out >>> 0;
      });
      return;
    case 0x6b: {
      // 0x4482E0: adds the sprite colour scaled by level and the source red channel.
      const color = state.color;
      eachPixel(target, source, span, (src, dst) =>
        saturatingAdd(
          scaleRgb(ADD_TABLE, 255 - ((alpha * ((src >>> 16) & 0xff)) >> 8), color),
          dst,
        ),
      );
      return;
    }
    case 0x6c:
    case 0x6d: {
      // 0x448490 / 0x448600: darken or brighten wherever the source red channel is set.
      const table = mode === 0x6c ? ADD_TABLE : DEL_TABLE;
      eachPixel(target, source, span, (src, dst) =>
        (src >>> 16) & 0xff ? ((dst & 0xff000000) | scaleRgb(table, alpha, dst)) >>> 0 : undefined,
      );
      return;
    }
  }
}

/** Blend mode 0 by mask mode (0x443FB0, 0x444180, 0x444270, 0x443ED0). */
function blendNormal(
  target: RScriptSurface,
  source: RScriptSurface,
  span: Span,
  mask: number,
  threshold: number,
): void {
  switch (mask) {
    case -1:
      return;
    case 0:
      eachPixel(target, source, span, transparencyBlend);
      return;
    case 1:
      eachPixel(target, source, span, (src) => (src >>> 24 < threshold ? src : undefined));
      return;
    case 2: {
      const limit = Math.min(threshold + 31, 254);
      eachPixel(target, source, span, (src, dst) => {
        const t = src >>> 24;
        if (t > limit) return undefined;
        if (t <= threshold) return src;
        return mixRgb(src, dst, (8 * (t - threshold)) & 0xff);
      });
      return;
    }
    case 3:
    case 4:
    case 5: {
      // 0x444470 / 0x444650 / 0x444830: wipes that fade to black, to white or additively.
      const limit = Math.min(threshold + 31, 254);
      const gray = (w: number): number => ADD_TABLE[(w << 8) | 0xff]! * 0x10101;
      eachPixel(target, source, span, (src, dst) => {
        const t = src >>> 24;
        if (t > limit) return undefined;
        if (t <= threshold) return mask === 3 ? 0 : mask === 4 ? 0xffffff : src;
        const w = (8 * (t - threshold)) & 0xff;
        if (mask === 5) return saturatingAdd(scaleRgb(ADD_TABLE, w, src), dst);
        return (scaleRgb(ADD_TABLE, 255 - w, dst) + (mask === 4 ? gray(w) : 0)) >>> 0;
      });
      return;
    }
    default:
      copyRows(target, source, span);
  }
}

/**
 * Source-over compositing that keeps transparency (0x447840), used to assemble
 * off-screen sprites such as shadowed glyphs.
 */
export function compositeOver(
  target: RScriptSurface,
  source: RScriptSurface,
  x: number,
  y: number,
): void {
  const span = clipSprite(target, source, x, y, {
    left: 0,
    top: 0,
    right: target.width,
    bottom: target.height,
  });
  if (!span) return;
  eachPixel(target, source, span, (src, dst) => {
    const t = src >>> 24;
    if (t === 0xff) return undefined;
    if (!t) return src;
    const sourceAlpha = 255 - t;
    const covered = ((t * (255 - (dst >>> 24)) + 255) >>> 8) & 0xff;
    const alpha = sourceAlpha + covered;
    const weight = Math.trunc((255 * sourceAlpha) / alpha) & 0xff;
    const a = weight << 8,
      b = (255 - weight) << 8;
    return (
      ((ADD_TABLE[a | (dst & 0xff)]! + ADD_TABLE[b | (src & 0xff)]!) |
        ((ADD_TABLE[a | ((dst >>> 8) & 0xff)]! + ADD_TABLE[b | ((src >>> 8) & 0xff)]!) << 8) |
        ((ADD_TABLE[a | ((dst >>> 16) & 0xff)]! + ADD_TABLE[b | ((src >>> 16) & 0xff)]!) << 16) |
        (((255 - alpha) & 0xff) << 24)) >>>
      0
    );
  });
}
