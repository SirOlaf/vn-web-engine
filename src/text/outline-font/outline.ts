/** A reusable glyph outline in FreeType's `FT_Outline` layout: 26.6 points (x, y interleaved),
 * point tags and contour end indices. Buffers grow on demand and are kept between glyphs.
 */
import {FontError, FontErrorCode} from './sfnt.js';

export const TAG_ON = 1,
  TAG_CUBIC = 2;

/** `FT_OUTLINE_POINTS_MAX` / `FT_OUTLINE_CONTOURS_MAX` after the glyph loader's 8-element padding. */
const LOADER_LIMIT = 0x7fff;

export class Outline {
  points = new Int32Array(512);
  tags = new Uint8Array(256);
  contours = new Int16Array(64);
  nPoints = 0;
  nContours = 0;

  reset(): void {
    this.nPoints = 0;
    this.nContours = 0;
  }

  /** `FT_GlyphLoader_CheckPoints` for `points` more points and `contours` more contours. */
  reserve(points: number, contours: number): void {
    const p = this.nPoints + points,
      c = this.nContours + contours;
    if ((p > 0 && ((p + 7) & ~7) > LOADER_LIMIT) || (c > 0 && ((c + 7) & ~7) > LOADER_LIMIT))
      throw new FontError(FontErrorCode.ArrayTooLarge);
    if (p > this.tags.length) {
      const size = Math.max(p, this.tags.length * 2);
      const points = new Int32Array(size * 2),
        tags = new Uint8Array(size);
      points.set(this.points.subarray(0, this.nPoints * 2));
      tags.set(this.tags.subarray(0, this.nPoints));
      this.points = points;
      this.tags = tags;
    }
    if (c > this.contours.length) {
      const contours = new Int16Array(Math.max(c, this.contours.length * 2));
      contours.set(this.contours.subarray(0, this.nContours));
      this.contours = contours;
    }
  }

  translate(dx: number, dy: number, from = 0): void {
    const v = this.points,
      end = this.nPoints * 2;
    if (dx) for (let i = from * 2; i < end; i += 2) v[i] = (v[i]! + dx) | 0;
    if (dy) for (let i = from * 2 + 1; i < end; i += 2) v[i] = (v[i]! + dy) | 0;
  }

  /** `FT_Outline_Check`; throws Invalid_Argument for an inconsistent outline. */
  check(): void {
    const n = this.nPoints,
      c = this.nContours;
    if (n === 0 && c === 0) return;
    if (n <= 0 || c <= 0) throw new FontError(FontErrorCode.InvalidArgument);
    let end0 = -1,
      end = -1;
    for (let i = 0; i < c; i++) {
      end = this.contours[i]!;
      if (end <= end0 || end >= n) throw new FontError(FontErrorCode.InvalidArgument);
      end0 = end;
    }
    if (end !== n - 1) throw new FontError(FontErrorCode.InvalidArgument);
  }
}
