import type {TriangleImage} from '../../graphics/triangle-draw.js';
import type {ArtemisFileGlyph, ArtemisFileFontMetrics} from './file-fonts.js';
import {artemisRevision} from './revision.js';

export interface ArtemisGlyphPaint {
  readonly color: number;
  readonly shadowColor: number;
  readonly outlineColor: number;
  readonly shadow: number;
  readonly outline: number;
  readonly underline?: boolean;
  readonly strikeout?: boolean;
  readonly decorationMetrics?: ArtemisFileFontMetrics;
}
export interface ArtemisGlyphSurface {
  readonly image: TriangleImage | null;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
}
const f = Math.fround;
const channels = (color: number) => [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
/** Grayscale branch of166420, including native underline/strikeout rows. Native atlas allocation is
 * replaced by independently owned RGBA storage; color math/quad padding remain.
 * CPU jobs run in the dedicated engine glyph worker, not the presentation frame.
 *
 * A glyph with its own `color` (32-bit rendered fonts; PE32 painter 0x525830/0x5259e0)
 * keeps those RGBA pixels unchanged without an outline. Its alpha is the coverage for the
 * outline and shadow, and its RGB replaces the foreground color where it is composited over
 * the outline. Underline and strikeout rows keep the foreground color.
 */
export function paintArtemisGrayGlyph(
  executableSha256: string,
  glyph: ArtemisFileGlyph,
  style: ArtemisGlyphPaint,
): ArtemisGlyphSurface {
  artemisRevision(executableSha256);
  const {width: gw, height: gh} = glyph,
    {outline: r, shadow: s} = style;
  for (const value of [gw, gh])
    if (!Number.isInteger(value) || value < 0 || value > 4096)
      throw Error('Unsupported Artemis glyph dimensions');
  if (
    glyph.pixels.length !== gw * gh ||
    !Number.isInteger(glyph.advance) ||
    glyph.advance < -0x80000000 ||
    glyph.advance > 0x7fffffff ||
    ![glyph.left, glyph.top].every(Number.isFinite)
  )
    throw Error('Invalid Artemis glyph coverage');
  if (glyph.color && glyph.color.length !== gw * gh * 4) throw Error('Invalid Artemis glyph color');
  if (!Number.isInteger(r) || r < 0 || r > 32 || !Number.isInteger(s) || s < 0 || s > 4096)
    throw Error('Unsupported Artemis glyph edge size');
  for (const value of [style.color, style.shadowColor, style.outlineColor])
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw Error('Invalid Artemis glyph color');
  const advance = f((glyph.advance + 2 * r + s) >>> 0);
  const empty = !gw || !gh;
  if (empty && (glyph.advance < 1 || (!style.underline && !style.strikeout)))
    return {image: null, left: 0, top: 0, advance: glyph.advance < 1 ? 0 : advance};
  let left = empty ? 0 : glyph.left,
    top = empty ? 0 : glyph.top;
  const rawWidth = empty ? 0 : gw,
    rawHeight = empty ? 0 : gh;
  let width = rawWidth + 2 * r + s,
    height = rawHeight + 2 * r + s,
    padX = r,
    padY = r;
  let underlineY = -1,
    strikeoutY = -1,
    underlineThickness = 0,
    strikeoutThickness = 0;
  if (style.underline || style.strikeout) {
    const metrics = style.decorationMetrics;
    if (!metrics) throw Error('Artemis glyph decorations require font metrics');
    for (const value of [
      metrics.underlinePosition,
      metrics.strikeoutPosition,
      metrics.underlineThickness,
      metrics.decorationThickness,
    ])
      if (!Number.isInteger(value) || Math.abs(value) > 4096)
        throw Error('Unsupported Artemis glyph decoration metrics');
    if (metrics.underlineThickness < 1 || metrics.decorationThickness < 1)
      throw Error('Unsupported Artemis glyph decoration thickness');
    if (rawWidth < glyph.advance - left) width += glyph.advance - rawWidth - left;
    if (left > 0) {
      width += left;
      padX += left;
      left = 0;
    }
    if (style.underline) {
      underlineThickness = metrics.underlineThickness;
      const end = metrics.underlinePosition - top + underlineThickness;
      if (rawHeight < end) height += end - rawHeight;
      underlineY = metrics.underlinePosition - top;
      if (underlineY < 0) {
        height -= underlineY;
        padY -= underlineY;
        top += underlineY;
        underlineY = 0;
      }
    }
    if (style.strikeout) {
      strikeoutThickness = metrics.decorationThickness;
      const end = metrics.strikeoutPosition - top + strikeoutThickness;
      if (rawHeight < end) height += end - rawHeight;
      strikeoutY = metrics.strikeoutPosition - top;
      if (strikeoutY < 0) {
        height -= strikeoutY;
        padY -= strikeoutY;
        top += strikeoutY;
        underlineY -= strikeoutY;
        strikeoutY = 0;
      }
    }
  }
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height * (2 * r + 1) ** 2 > 16 * 1024 * 1024
  )
    throw Error('Artemis glyph paint budget exceeded');
  const foreground = channels(style.color),
    outline = channels(style.outlineColor),
    shadow = channels(style.shadowColor),
    pixels = new Uint8Array(width * height * 4);
  const decoration = (y: number) =>
    (style.underline && y >= underlineY && y < underlineY + underlineThickness) ||
    (style.strikeout && y >= strikeoutY && y < strikeoutY + strikeoutThickness);
  // Index of the glyph pixel at (x, y), or -1 in padding.
  const source = (x: number, y: number) =>
    empty || x < padX || y < padY || x >= rawWidth + padX || y >= rawHeight + padY
      ? -1
      : (y - padY) * gw + x - padX;
  const coverage = (x: number, y: number) => {
    if (decoration(y)) return 255;
    const index = source(x, y);
    return index < 0 ? 0 : glyph.pixels[index]!;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4,
        center = coverage(x, y),
        own = glyph.color && !decoration(y) ? source(x, y) : -1,
        fill = own < 0 ? foreground : glyph.color!.subarray(own * 4, own * 4 + 3);
      if (!r) {
        pixels.set(fill, at);
        pixels[at + 3] = center;
      } else if (center) {
        const a = f(center / 255),
          inverse = f(1 - a);
        for (let c = 0; c < 3; c++)
          pixels[at + c] = Math.trunc(f(f(outline[c]! * inverse) + f(fill[c]! * a)));
        pixels[at + 3] = 255;
      } else {
        let edge = 0;
        for (let sy = y - r; sy <= y + r; sy++)
          for (let sx = x - r; sx <= x + r; sx++) edge = Math.max(edge, coverage(sx, sy));
        pixels.set(outline, at);
        pixels[at + 3] = Math.trunc(f(f(edge / 255) * 255));
      }
    }
  if (s)
    for (let y = height - s - 1; y >= 0; y--)
      for (let x = 0; x < width - s; x++) {
        const source = (y * width + x) * 4,
          destination = ((y + s) * width + x + s) * 4;
        if (!pixels[source + 3] || pixels[destination + 3] === 255) continue;
        const sa = f(pixels[source + 3]! / 255),
          da = f(pixels[destination + 3]! / 255),
          inverse = f(1 - da),
          alpha = f(f(inverse * sa) + da);
        for (let c = 0; c < 3; c++)
          pixels[destination + c] = Math.trunc(
            f(f(f(f(shadow[c]! * sa) * inverse) + f(pixels[destination + c]! * da)) / alpha),
          );
        pixels[destination + 3] = Math.trunc(f(alpha * 255));
      }
  return {image: {width, height, pixels}, left: f(left), top: f(top), advance};
}
