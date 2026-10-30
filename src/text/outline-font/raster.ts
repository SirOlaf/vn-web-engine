/** Anti-aliased outline rasterizer with the arithmetic of FreeType 2.4.8's `ftgrays.c`
 * (PIXEL_BITS 8, nonzero fill, 32-bit `TPos`/`TArea` wrapping like the 32-bit C build). This
 * is the JavaScript fallback of `wasm/outline-raster`, which runs the same algorithm. Cells accumulate in dense per-row
 * cover/area arrays instead of FreeType's banded cell lists; the sweep visits the same cells in
 * the same order, so every coverage value is identical.
 */
import {Outline, TAG_CUBIC, TAG_ON} from './outline.js';
import {FontError, FontErrorCode} from './sfnt.js';

const ONE_PIXEL = 256;

/** Renders a translated outline into a `width` × `height` coverage bitmap and, when `xstr` or
 * `ystr` is non-zero, emboldens it by that many pixels.
 */
export interface OutlineRasterizer {
  render(outline: Outline, width: number, height: number, xstr: number, ystr: number): Uint8Array;
}

export class JsOutlineRasterizer implements OutlineRasterizer {
  private readonly raster = new GrayRaster();

  render(outline: Outline, width: number, height: number, xstr: number, ystr: number): Uint8Array {
    const pixels = new Uint8Array(width * height);
    this.raster.render(outline, width, height, pixels);
    return xstr || ystr ? embolden(pixels, width, height, xstr, ystr) : pixels;
  }
}

export class GrayRaster {
  private cover = new Int32Array(0);
  private area = new Int32Array(0);
  private stride = 0;
  private minEx = 0;
  private maxEx = 0;
  private minEy = 0;
  private maxEy = 0;
  private countEx = 0;
  private countEy = 0;
  // Current cell (`TWorker`).
  private ex = 0;
  private ey = 0;
  private cellArea = 0;
  private cellCover = 0;
  private invalid = true;
  private x = 0;
  private y = 0;
  private lastEy = 0;
  private readonly bez = new Int32Array(2 * (32 * 3 + 1));
  private readonly levels = new Int32Array(32);

  /** Renders `outline` (already translated into the bitmap) into `out` (top-down rows of
   * `width` bytes, zero-filled by the caller), like `gray_raster_render` with the bitmap as
   * clip box.
   */
  render(outline: Outline, width: number, height: number, out: Uint8Array): void {
    const n = outline.nPoints,
      c = outline.nContours;
    if (n === 0 || c <= 0) return;
    if (n !== outline.contours[c - 1]! + 1) throw new FontError(FontErrorCode.InvalidOutline);
    if (!width || !height) return;
    // gray_compute_cbox + clip to the target.
    const v = outline.points;
    let xMin = v[0]!,
      xMax = xMin,
      yMin = v[1]!,
      yMax = yMin;
    for (let i = 2; i < n * 2; i += 2) {
      const x = v[i]!,
        y = v[i + 1]!;
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    let minEx = xMin >> 6,
      minEy = yMin >> 6,
      maxEx = (xMax + 63) >> 6,
      maxEy = (yMax + 63) >> 6;
    if (maxEx <= 0 || minEx >= width || maxEy <= 0 || minEy >= height) return;
    if (minEx < 0) minEx = 0;
    if (minEy < 0) minEy = 0;
    if (maxEx > width) maxEx = width;
    if (maxEy > height) maxEy = height;
    this.minEx = minEx;
    this.maxEx = maxEx;
    this.minEy = minEy;
    this.maxEy = maxEy;
    this.countEx = maxEx - minEx;
    this.countEy = maxEy - minEy;
    this.stride = this.countEx + 1;
    const cells = this.stride * this.countEy;
    if (this.cover.length < cells) {
      this.cover = new Int32Array(cells);
      this.area = new Int32Array(cells);
    } else {
      this.cover.fill(0, 0, cells);
      this.area.fill(0, 0, cells);
    }
    this.cellArea = 0;
    this.cellCover = 0;
    this.invalid = true;
    this.decompose(outline);
    this.recordCell();
    this.sweep(width, height, out);
  }

  /** `FT_Outline_Decompose` with shift 0 and delta 0. */
  private decompose(outline: Outline): void {
    const v = outline.points,
      tags = outline.tags,
      contours = outline.contours;
    let first = 0;
    for (let n = 0; n < outline.nContours; n++) {
      const last = contours[n]!;
      if (last < 0) throw new FontError(FontErrorCode.InvalidOutline);
      let limit = last;
      let startX = v[first * 2]!,
        startY = v[first * 2 + 1]!;
      const lastX = v[last * 2]!,
        lastY = v[last * 2 + 1]!;
      let controlX = startX,
        controlY = startY;
      let point = first;
      let tag = tags[first]! & 3;
      if (tag === TAG_CUBIC) throw new FontError(FontErrorCode.InvalidOutline);
      if (tag === 0) {
        if ((tags[last]! & 3) === TAG_ON) {
          startX = lastX;
          startY = lastY;
          limit--;
        } else {
          startX = ((startX + lastX) / 2) | 0;
          startY = ((startY + lastY) / 2) | 0;
        }
        point--;
      }
      this.moveTo(startX, startY);
      let closed = false;
      contour: while (point < limit) {
        point++;
        tag = tags[point]! & 3;
        if (tag === TAG_ON) {
          this.renderLine(v[point * 2]! << 2, v[point * 2 + 1]! << 2);
          continue;
        }
        if (tag === 0) {
          controlX = v[point * 2]!;
          controlY = v[point * 2 + 1]!;
          for (;;) {
            if (point < limit) {
              point++;
              tag = tags[point]! & 3;
              const x = v[point * 2]!,
                y = v[point * 2 + 1]!;
              if (tag === TAG_ON) {
                this.renderConic(controlX, controlY, x, y);
                continue contour;
              }
              if (tag !== 0) throw new FontError(FontErrorCode.InvalidOutline);
              this.renderConic(
                controlX,
                controlY,
                ((controlX + x) / 2) | 0,
                ((controlY + y) / 2) | 0,
              );
              controlX = x;
              controlY = y;
              continue;
            }
            this.renderConic(controlX, controlY, startX, startY);
            closed = true;
            break contour;
          }
        }
        // Cubic: two control points, then an on point or the contour start.
        if (point + 1 > limit || (tags[point + 1]! & 3) !== TAG_CUBIC)
          throw new FontError(FontErrorCode.InvalidOutline);
        point += 2;
        const c1x = v[(point - 2) * 2]!,
          c1y = v[(point - 2) * 2 + 1]!,
          c2x = v[(point - 1) * 2]!,
          c2y = v[(point - 1) * 2 + 1]!;
        if (point <= limit) {
          this.renderCubic(c1x, c1y, c2x, c2y, v[point * 2]!, v[point * 2 + 1]!);
          continue;
        }
        this.renderCubic(c1x, c1y, c2x, c2y, startX, startY);
        closed = true;
        break;
      }
      if (!closed) this.renderLine(startX << 2, startY << 2);
      first = last + 1;
    }
  }

  private recordCell(): void {
    if (!this.invalid && this.cellArea | this.cellCover) {
      const ex = this.ex > this.countEx ? this.countEx : this.ex;
      const i = this.ey * this.stride + ex + 1;
      this.area[i] = (this.area[i]! + this.cellArea) | 0;
      this.cover[i] = (this.cover[i]! + this.cellCover) | 0;
    }
  }

  private setCell(ex: number, ey: number): void {
    ey -= this.minEy;
    if (ex > this.maxEx) ex = this.maxEx;
    ex -= this.minEx;
    if (ex < 0) ex = -1;
    if (ex !== this.ex || ey !== this.ey) {
      if (!this.invalid) this.recordCell();
      this.cellArea = 0;
      this.cellCover = 0;
    }
    this.ex = ex;
    this.ey = ey;
    this.invalid = ey >>> 0 >= this.countEy >>> 0 || ex >= this.countEx;
  }

  private moveTo(x: number, y: number): void {
    this.recordCell();
    x <<= 2;
    y <<= 2;
    // gray_start_cell
    let ex = x >> 8;
    const ey = y >> 8;
    if (ex > this.maxEx) ex = this.maxEx;
    if (ex < this.minEx) ex = this.minEx - 1;
    this.cellArea = 0;
    this.cellCover = 0;
    this.ex = ex - this.minEx;
    this.ey = ey - this.minEy;
    this.lastEy = ey << 8;
    this.invalid = false;
    this.setCell(ex, ey);
    this.x = x;
    this.y = y;
  }

  private renderScanline(ey: number, x1: number, y1: number, x2: number, y2: number): void {
    let dx = x2 - x1;
    let ex1 = x1 >> 8;
    const ex2 = x2 >> 8,
      fx1 = x1 - (ex1 << 8),
      fx2 = x2 - (ex2 << 8);
    if (y1 === y2) {
      this.setCell(ex2, ey);
      return;
    }
    if (ex1 === ex2) {
      const delta = y2 - y1;
      this.cellArea = (this.cellArea + (fx1 + fx2) * delta) | 0;
      this.cellCover = (this.cellCover + delta) | 0;
      return;
    }
    let p = Math.imul(ONE_PIXEL - fx1, y2 - y1),
      first = ONE_PIXEL,
      incr = 1;
    if (dx < 0) {
      p = Math.imul(fx1, y2 - y1);
      first = 0;
      incr = -1;
      dx = -dx;
    }
    let delta = (p / dx) | 0,
      mod = p % dx;
    if (mod < 0) {
      delta--;
      mod += dx;
    }
    this.cellArea = (this.cellArea + (fx1 + first) * delta) | 0;
    this.cellCover = (this.cellCover + delta) | 0;
    ex1 += incr;
    this.setCell(ex1, ey);
    y1 += delta;
    if (ex1 !== ex2) {
      p = Math.imul(ONE_PIXEL, y2 - y1 + delta);
      let lift = (p / dx) | 0,
        rem = p % dx;
      if (rem < 0) {
        lift--;
        rem += dx;
      }
      mod -= dx;
      while (ex1 !== ex2) {
        delta = lift;
        mod += rem;
        if (mod >= 0) {
          mod -= dx;
          delta++;
        }
        this.cellArea = (this.cellArea + ONE_PIXEL * delta) | 0;
        this.cellCover = (this.cellCover + delta) | 0;
        y1 += delta;
        ex1 += incr;
        this.setCell(ex1, ey);
      }
    }
    delta = y2 - y1;
    this.cellArea = (this.cellArea + (fx2 + ONE_PIXEL - first) * delta) | 0;
    this.cellCover = (this.cellCover + delta) | 0;
  }

  /** `gray_render_line` to a point in 24.8 subpixels. */
  private renderLine(toX: number, toY: number): void {
    let ey1 = this.lastEy >> 8;
    const ey2 = toY >> 8,
      fy1 = this.y - this.lastEy,
      fy2 = toY - (ey2 << 8);
    let dx = toX - this.x,
      dy = toY - this.y;
    const min = ey1 < ey2 ? ey1 : ey2,
      max = ey1 < ey2 ? ey2 : ey1;
    if (!(min >= this.maxEy || max < this.minEy)) {
      if (ey1 === ey2) this.renderScanline(ey1, this.x, fy1, toX, fy2);
      else if (dx === 0) {
        const ex = this.x >> 8,
          twoFx = (this.x - (ex << 8)) << 1;
        let first = ONE_PIXEL,
          incr = 1;
        if (dy < 0) {
          first = 0;
          incr = -1;
        }
        let delta = first - fy1;
        this.cellArea = (this.cellArea + twoFx * delta) | 0;
        this.cellCover = (this.cellCover + delta) | 0;
        ey1 += incr;
        this.setCell(ex, ey1);
        delta = first + first - ONE_PIXEL;
        const area = twoFx * delta;
        while (ey1 !== ey2) {
          this.cellArea = (this.cellArea + area) | 0;
          this.cellCover = (this.cellCover + delta) | 0;
          ey1 += incr;
          this.setCell(ex, ey1);
        }
        delta = fy2 - ONE_PIXEL + first;
        this.cellArea = (this.cellArea + twoFx * delta) | 0;
        this.cellCover = (this.cellCover + delta) | 0;
      } else {
        let p = Math.imul(ONE_PIXEL - fy1, dx),
          first = ONE_PIXEL,
          incr = 1;
        if (dy < 0) {
          p = Math.imul(fy1, dx);
          first = 0;
          incr = -1;
          dy = -dy;
        }
        let delta = (p / dy) | 0,
          mod = p % dy;
        if (mod < 0) {
          delta--;
          mod += dy;
        }
        let x = this.x + delta;
        this.renderScanline(ey1, this.x, fy1, x, first);
        ey1 += incr;
        this.setCell(x >> 8, ey1);
        if (ey1 !== ey2) {
          p = Math.imul(ONE_PIXEL, dx);
          let lift = (p / dy) | 0,
            rem = p % dy;
          if (rem < 0) {
            lift--;
            rem += dy;
          }
          mod -= dy;
          while (ey1 !== ey2) {
            delta = lift;
            mod += rem;
            if (mod >= 0) {
              mod -= dy;
              delta++;
            }
            const x2 = x + delta;
            this.renderScanline(ey1, x, ONE_PIXEL - first, x2, first);
            x = x2;
            ey1 += incr;
            this.setCell(x >> 8, ey1);
          }
        }
        this.renderScanline(ey1, x, ONE_PIXEL - first, toX, fy2);
      }
    }
    this.x = toX;
    this.y = toY;
    this.lastEy = ey2 << 8;
  }

  /** `gray_render_conic` (26.6 control and end point). */
  private renderConic(cx: number, cy: number, tx: number, ty: number): void {
    const arc = this.bez,
      levels = this.levels;
    arc[0] = tx << 2;
    arc[1] = ty << 2;
    arc[2] = cx << 2;
    arc[3] = cy << 2;
    arc[4] = this.x;
    arc[5] = this.y;
    let a = 0,
      top = 0;
    let dx = Math.abs(arc[4]! + arc[0]! - 2 * arc[2]!),
      dy = Math.abs(arc[5]! + arc[1]! - 2 * arc[3]!);
    if (dx < dy) dx = dy;
    let draw = dx < ONE_PIXEL / 4;
    if (!draw) {
      let min = arc[1]!,
        max = min;
      for (let i = 3; i <= 5; i += 2) {
        const y = arc[i]!;
        if (y < min) min = y;
        if (y > max) max = y;
      }
      draw = min >> 8 >= this.maxEy || max >> 8 < this.minEy;
    }
    if (draw) {
      this.renderLine(arc[0]!, arc[1]!);
      return;
    }
    let level = 0;
    do {
      dx >>= 2;
      level++;
    } while (dx > ONE_PIXEL / 4);
    levels[0] = level;
    do {
      level = levels[top]!;
      if (level > 0) {
        // gray_split_conic on arc[a..a+4]
        const o = a * 2;
        let p, q;
        arc[o + 8] = arc[o + 4]!;
        q = arc[o + 2]!;
        p = arc[o + 6] = ((arc[o + 4]! + q) / 2) | 0;
        q = arc[o + 2] = ((arc[o]! + q) / 2) | 0;
        arc[o + 4] = ((p + q) / 2) | 0;
        arc[o + 9] = arc[o + 5]!;
        q = arc[o + 3]!;
        p = arc[o + 7] = ((arc[o + 5]! + q) / 2) | 0;
        q = arc[o + 3] = ((arc[o + 1]! + q) / 2) | 0;
        arc[o + 5] = ((p + q) / 2) | 0;
        a += 2;
        top++;
        levels[top] = levels[top - 1] = level - 1;
        continue;
      }
      this.renderLine(arc[a * 2]!, arc[a * 2 + 1]!);
      top--;
      a -= 2;
    } while (top >= 0);
  }

  /** `gray_render_cubic` (26.6 control points and end point). */
  private renderCubic(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    tx: number,
    ty: number,
  ): void {
    const arc = this.bez;
    arc[0] = tx << 2;
    arc[1] = ty << 2;
    arc[2] = c2x << 2;
    arc[3] = c2y << 2;
    arc[4] = c1x << 2;
    arc[5] = c1y << 2;
    arc[6] = this.x;
    arc[7] = this.y;
    let min = arc[1]!,
      max = min;
    for (let i = 3; i <= 7; i += 2) {
      const y = arc[i]!;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    let o = 0;
    if (min >> 8 >= this.maxEy || max >> 8 < this.minEy) {
      this.renderLine(arc[0]!, arc[1]!);
      return;
    }
    for (;;) {
      const x0 = arc[o]!,
        y0 = arc[o + 1]!,
        x1 = arc[o + 2]!,
        y1 = arc[o + 3]!,
        x2 = arc[o + 4]!,
        y2 = arc[o + 5]!,
        x3 = arc[o + 6]!,
        y3 = arc[o + 7]!;
      const dx = (x3 - x0) | 0,
        dy = (y3 - y0) | 0;
      const ax = dx < 0 ? -dx | 0 : dx,
        ay = dy < 0 ? -dy | 0 : dy;
      const L =
        ((ax > ay
          ? Math.imul(236, ax) + Math.imul(97, ay)
          : Math.imul(97, ax) + Math.imul(236, ay)) |
          0) >>
        8;
      let split = L > 32767;
      if (!split) {
        const sLimit = Math.imul(L, (ONE_PIXEL / 6) | 0);
        const dx1 = (x1 - x0) | 0,
          dy1 = (y1 - y0) | 0,
          dx2 = (x2 - x0) | 0,
          dy2 = (y2 - y0) | 0;
        let s = (Math.imul(dy, dx1) - Math.imul(dx, dy1)) | 0;
        if (s < 0) s = -s | 0;
        if (s > sLimit) split = true;
        else {
          s = (Math.imul(dy, dx2) - Math.imul(dx, dy2)) | 0;
          if (s < 0) s = -s | 0;
          if (s > sLimit) split = true;
          else
            split =
              ((Math.imul(dy, dy1) + Math.imul(dx, dx1)) | 0) < 0 ||
              ((Math.imul(dy, dy2) + Math.imul(dx, dx2)) | 0) < 0 ||
              ((Math.imul(dy, (y3 - y1) | 0) + Math.imul(dx, (x3 - x1) | 0)) | 0) < 0 ||
              ((Math.imul(dy, (y3 - y2) | 0) + Math.imul(dx, (x3 - x2) | 0)) | 0) < 0;
        }
      }
      if (split) {
        // gray_split_cubic on arc[o..o+12]
        let a, b, c, d;
        arc[o + 12] = x3;
        c = x1;
        d = x2;
        arc[o + 2] = a = ((x0 + c) / 2) | 0;
        arc[o + 10] = b = ((x3 + d) / 2) | 0;
        c = ((c + d) / 2) | 0;
        arc[o + 4] = a = ((a + c) / 2) | 0;
        arc[o + 8] = b = ((b + c) / 2) | 0;
        arc[o + 6] = ((a + b) / 2) | 0;
        arc[o + 13] = y3;
        c = y1;
        d = y2;
        arc[o + 3] = a = ((y0 + c) / 2) | 0;
        arc[o + 11] = b = ((y3 + d) / 2) | 0;
        c = ((c + d) / 2) | 0;
        arc[o + 5] = a = ((a + c) / 2) | 0;
        arc[o + 9] = b = ((b + c) / 2) | 0;
        arc[o + 7] = ((a + b) / 2) | 0;
        o += 6;
        continue;
      }
      this.renderLine(x0, y0);
      if (o === 0) return;
      o -= 6;
    }
  }

  /** `gray_sweep` + `gray_hline` + `gray_render_span` for the nonzero rule. */
  private sweep(width: number, height: number, out: Uint8Array): void {
    const cover = this.cover,
      area = this.area,
      stride = this.stride,
      countEx = this.countEx;
    for (let y = 0; y < this.countEy; y++) {
      const row = (height - 1 - (y + this.minEy)) * width + this.minEx,
        base = y * stride;
      let c = cover[base]!; // the clipped cell left of the bitmap
      for (let x = 0; x < countEx; x++) {
        c = (c + cover[base + x + 1]!) | 0;
        const a = (Math.imul(c, ONE_PIXEL * 2) - area[base + x + 1]!) | 0;
        let coverage = a >> 9;
        if (coverage < 0) coverage = -coverage;
        out[row + x] = coverage >= 256 ? 255 : coverage;
      }
    }
  }
}

/** `FT_Bitmap_Embolden` on an 8-bit bitmap (positive pitch): every pixel adds the `xstr`
 * pixels to its left with saturation, then each row is OR-ed into the `ystr` rows above it.
 * Coverage is never negative, so the saturating chain is the window sum clamped to 255.
 */
export function embolden(
  src: Uint8Array,
  width: number,
  rows: number,
  xstr: number,
  ystr: number,
): Uint8Array {
  const pitch = width + xstr,
    out = new Uint8Array(pitch * (rows + ystr));
  for (let y = 0; y < rows; y++) {
    const s = y * width,
      p = (y + ystr) * pitch;
    let sum = 0;
    for (let x = 0; x < pitch; x++) {
      if (x < width) sum += src[s + x]!;
      if (x > xstr && x - xstr - 1 < width) sum -= src[s + x - xstr - 1]!;
      out[p + x] = sum > 255 ? 255 : sum;
    }
  }
  // Ascending rows: row r becomes the OR of rows r..r + ystr, which are still unmerged.
  const total = rows + ystr;
  for (let r = 0; r < total; r++) {
    const p = r * pitch;
    for (let k = 1; k <= ystr && r + k < total; k++) {
      const q = (r + k) * pitch;
      for (let i = 0; i < pitch; i++) out[p + i]! |= out[q + i]!;
    }
  }
  return out;
}
