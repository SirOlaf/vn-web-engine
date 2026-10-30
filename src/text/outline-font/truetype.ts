/** TrueType (`glyf`/`loca`) outlines as FreeType 2.4.8's `truetype` driver loads them without
 * hinting (`ttpload.c`, `ttgload.c`): simple and composite glyphs, phantom points and
 * 16.16 scaling of every point with `FT_MulFix`.
 */
import {mulFix, pixRound, sqrtFixed, transform, type Matrix} from './fixed.js';
import {Outline} from './outline.js';
import {FontError, FontErrorCode, type Sfnt} from './sfnt.js';

const ARGS_ARE_WORDS = 0x0001,
  ARGS_ARE_XY_VALUES = 0x0002,
  ROUND_XY_TO_GRID = 0x0004,
  WE_HAVE_A_SCALE = 0x0008,
  MORE_COMPONENTS = 0x0020,
  WE_HAVE_AN_XY_SCALE = 0x0040,
  WE_HAVE_A_2X2 = 0x0080,
  USE_MY_METRICS = 0x0200,
  SCALED_COMPONENT_OFFSET = 0x0800;

interface SubGlyph {
  flags: number;
  index: number;
  arg1: number;
  arg2: number;
  transform: Matrix;
}

export class TrueTypeOutlines {
  private readonly glyfOffset: number;
  private readonly glyfLength: number;
  private readonly locaOffset: number;
  private readonly locations: number;
  private readonly longOffsets: boolean;
  // Loader state (`TT_LoaderRec`).
  private xScale = 0;
  private yScale = 0;
  private outline!: Outline;
  private pp1x = 0;
  private pp2x = 0;

  constructor(private readonly sfnt: Sfnt) {
    // tt_face_load_hdmx only validates the header here; device widths apply to hinted loads.
    const hdmx = sfnt.find('hdmx');
    if (hdmx && hdmx.length >= 8) {
      const b = sfnt.bytes;
      let recordSize = b.u32(hdmx.offset + 4);
      if (recordSize >= 0xffff0000) recordSize &= 0xffff;
      if (b.u16(hdmx.offset) !== 0 || b.u16(hdmx.offset + 2) > 255 || recordSize > 0x10001)
        throw new FontError(FontErrorCode.InvalidFileFormat);
    }
    const glyf = sfnt.find('glyf'),
      loca = sfnt.find('loca');
    this.glyfOffset = glyf?.offset ?? 0;
    this.glyfLength = glyf?.length ?? 0;
    if (!loca) throw new FontError(FontErrorCode.LocationsMissing);
    this.longOffsets = sfnt.indexToLocFormat !== 0;
    const shift = this.longOffsets ? 2 : 1;
    let length = loca.length;
    if (length >= (this.longOffsets ? 0x40000 : 0x20000))
      throw new FontError(FontErrorCode.InvalidTable);
    let locations = length >>> shift;
    if (locations !== sfnt.numGlyphs + 1 && locations <= sfnt.numGlyphs) {
      const wanted = (sfnt.numGlyphs + 1) << shift;
      // FreeType's distance search always ends at the file end (`entry == limit`).
      if (wanted <= sfnt.bytes.length - loca.offset) {
        locations = sfnt.numGlyphs + 1;
        length = wanted;
      }
    }
    sfnt.bytes.check(loca.offset, length);
    this.locaOffset = loca.offset;
    this.locations = locations;
  }

  /** Loads glyph `index` scaled to 26.6 into `outline`, translated by the left phantom point.
   * Returns the horizontal advance (`pp2.x - pp1.x`).
   */
  load(outline: Outline, index: number, xScale: number, yScale: number): number {
    this.outline = outline;
    this.xScale = xScale;
    this.yScale = yScale;
    outline.reset();
    this.loadGlyph(index, 0);
    if (this.pp1x) outline.translate(-this.pp1x, 0);
    return (this.pp2x - this.pp1x) | 0;
  }

  /** `tt_face_get_location`: [offset, size] inside `glyf`. */
  private location(index: number): [number, number] {
    const b = this.sfnt.bytes;
    let pos1 = 0,
      pos2 = 0;
    if (index < this.locations) {
      if (this.longOffsets) {
        pos1 = pos2 = b.u32(this.locaOffset + index * 4);
        if (index + 1 < this.locations) pos2 = b.u32(this.locaOffset + index * 4 + 4);
      } else {
        pos1 = pos2 = b.u16(this.locaOffset + index * 2);
        if (index + 1 < this.locations) pos2 = b.u16(this.locaOffset + index * 2 + 2);
        pos1 *= 2;
        pos2 *= 2;
      }
    }
    if (pos1 >= this.glyfLength) return [0, 0];
    if (pos2 >= this.glyfLength) pos2 = this.glyfLength;
    return [pos1, pos2 >= pos1 ? pos2 - pos1 : this.glyfLength - pos1];
  }

  /** `load_truetype_glyph` without hinting; leaves the phantom x coordinates in pp1x/pp2x. */
  private loadGlyph(index: number, recurse: number): void {
    const sfnt = this.sfnt,
      b = sfnt.bytes,
      outline = this.outline;
    if (recurse > 1 && recurse > sfnt.maxComponentDepth)
      throw new FontError(FontErrorCode.InvalidComposite);
    if (index >= sfnt.numGlyphs) throw new FontError(FontErrorCode.InvalidGlyphIndex);
    const [lsb, advance] = sfnt.metrics(false, index);
    const [offset, byteLength] = this.location(index);
    let p = 0,
      limit = 0,
      nContours = 0,
      xMin = 0;
    if (byteLength > 0) {
      if (!this.glyfOffset) throw new FontError(FontErrorCode.InvalidTable);
      p = this.glyfOffset + offset;
      limit = p + byteLength;
      b.check(p, byteLength);
      if (p + 10 > limit) throw new FontError(FontErrorCode.InvalidOutline);
      nContours = b.i16(p);
      xMin = b.i16(p + 2);
      p += 10;
    }
    // TT_LOADER_SET_PP (only the x coordinates of pp1 and pp2 reach the output).
    let pp1x = xMin - lsb,
      pp2x = pp1x + advance;
    if (byteLength === 0 || nContours === 0) {
      this.pp1x = mulFix(pp1x, this.xScale);
      this.pp2x = mulFix(pp2x, this.xScale);
      return;
    }
    if (nContours > 0) {
      this.loadSimple(p, limit, nContours);
      // TT_Process_Simple_Glyph: the phantom points are scaled with the outline.
      this.pp1x = mulFix(pp1x, this.xScale);
      this.pp2x = mulFix(pp2x, this.xScale);
      return;
    }
    if (nContours !== -1) throw new FontError(FontErrorCode.InvalidOutline);
    const startPoint = outline.nPoints;
    const subglyphs = this.readComposite(p, limit);
    pp1x = mulFix(pp1x, this.xScale);
    pp2x = mulFix(pp2x, this.xScale);
    this.pp1x = pp1x;
    this.pp2x = pp2x;
    for (const subglyph of subglyphs) {
      const savedPp1 = this.pp1x,
        savedPp2 = this.pp2x,
        basePoints = outline.nPoints;
      this.loadGlyph(subglyph.index, recurse + 1);
      if (!(subglyph.flags & USE_MY_METRICS)) {
        this.pp1x = savedPp1;
        this.pp2x = savedPp2;
      }
      if (outline.nPoints === basePoints) continue;
      this.processComponent(subglyph, startPoint, basePoints);
    }
  }

  /** `TT_Load_Simple_Glyph` + `TT_Process_Simple_Glyph` + `FT_GlyphLoader_Add`. */
  private loadSimple(p: number, limit: number, nContours: number): void {
    const b = this.sfnt.bytes,
      outline = this.outline;
    outline.reserve(0, nContours);
    if (nContours >= 0xfff || p + (nContours + 1) * 2 > limit)
      throw new FontError(FontErrorCode.InvalidOutline);
    const contours = outline.contours,
      c0 = outline.nContours;
    let prev = (b.u16(p) << 16) >> 16;
    p += 2;
    contours[c0] = prev;
    for (let i = 1; i < nContours; i++, p += 2) {
      const c = (b.u16(p) << 16) >> 16;
      if (c <= prev) throw new FontError(FontErrorCode.InvalidTable);
      contours[c0 + i] = prev = c;
    }
    const nPoints = prev + 1;
    if (nPoints < 0) throw new FontError(FontErrorCode.InvalidOutline);
    outline.reserve(nPoints + 4, 0);
    if (p + 2 > limit) throw new FontError(FontErrorCode.InvalidOutline);
    const nIns = b.u16(p);
    p += 2;
    if (nIns > this.sfnt.maxSizeOfInstructions || limit - p < nIns)
      throw new FontError(FontErrorCode.TooManyHints);
    p += nIns;
    const base = outline.nPoints,
      tags = outline.tags,
      flagLimit = base + nPoints;
    const data = b.data;
    for (let f = base; f < flagLimit;) {
      if (p + 1 > limit) throw new FontError(FontErrorCode.InvalidOutline);
      const c = data[p++]!;
      tags[f++] = c;
      if (c & 8) {
        if (p + 1 > limit) throw new FontError(FontErrorCode.InvalidOutline);
        let count = data[p++]!;
        if (f + count > flagLimit) throw new FontError(FontErrorCode.InvalidOutline);
        for (; count > 0; count--) tags[f++] = c;
      }
    }
    const points = outline.points,
      xScale = this.xScale,
      yScale = this.yScale;
    let x = 0;
    for (let i = base; i < flagLimit; i++) {
      const f = tags[i]!;
      let d = 0;
      if (f & 2) {
        if (p + 1 > limit) throw new FontError(FontErrorCode.InvalidOutline);
        d = data[p++]!;
        if (!(f & 16)) d = -d;
      } else if (!(f & 16)) {
        if (p + 2 > limit) throw new FontError(FontErrorCode.InvalidOutline);
        d = (((data[p]! << 8) | data[p + 1]!) << 16) >> 16;
        p += 2;
      }
      x += d;
      points[i * 2] = x;
    }
    let y = 0;
    for (let i = base; i < flagLimit; i++) {
      const f = tags[i]!;
      let d = 0;
      if (f & 4) {
        if (p + 1 > limit) throw new FontError(FontErrorCode.InvalidOutline);
        d = data[p++]!;
        if (!(f & 32)) d = -d;
      } else if (!(f & 32)) {
        if (p + 2 > limit) throw new FontError(FontErrorCode.InvalidOutline);
        d = (((data[p]! << 8) | data[p + 1]!) << 16) >> 16;
        p += 2;
      }
      y += d;
      points[i * 2 + 1] = y;
      tags[i] = f & 1;
    }
    for (let i = base * 2, end = flagLimit * 2; i < end; i += 2) {
      points[i] = mulFix(points[i]!, xScale);
      points[i + 1] = mulFix(points[i + 1]!, yScale);
    }
    // FT_GlyphLoader_Add: contour indices become absolute (as FT_Short).
    for (let i = 0; i < nContours; i++) contours[c0 + i] = contours[c0 + i]! + base;
    outline.nPoints += nPoints;
    outline.nContours += nContours;
  }

  /** `TT_Load_Composite_Glyph`. */
  private readComposite(p: number, limit: number): SubGlyph[] {
    const b = this.sfnt.bytes,
      out: SubGlyph[] = [];
    let flags: number;
    do {
      if (p + 4 > limit) throw new FontError(FontErrorCode.InvalidComposite);
      flags = b.u16(p);
      const index = b.u16(p + 2);
      p += 4;
      let count = 2;
      if (flags & ARGS_ARE_WORDS) count += 2;
      if (flags & WE_HAVE_A_SCALE) count += 2;
      else if (flags & WE_HAVE_AN_XY_SCALE) count += 4;
      else if (flags & WE_HAVE_A_2X2) count += 8;
      if (p + count > limit) throw new FontError(FontErrorCode.InvalidComposite);
      let arg1: number, arg2: number;
      if (flags & ARGS_ARE_WORDS) {
        arg1 = b.i16(p);
        arg2 = b.i16(p + 2);
        p += 4;
      } else {
        arg1 = (b.u8(p) << 24) >> 24;
        arg2 = (b.u8(p + 1) << 24) >> 24;
        p += 2;
      }
      const m: Matrix = {xx: 0x10000, xy: 0, yx: 0, yy: 0x10000};
      if (flags & WE_HAVE_A_SCALE) {
        m.xx = m.yy = b.i16(p) << 2;
        p += 2;
      } else if (flags & WE_HAVE_AN_XY_SCALE) {
        m.xx = b.i16(p) << 2;
        m.yy = b.i16(p + 2) << 2;
        p += 4;
      } else if (flags & WE_HAVE_A_2X2) {
        m.xx = b.i16(p) << 2;
        m.yx = b.i16(p + 2) << 2;
        m.xy = b.i16(p + 4) << 2;
        m.yy = b.i16(p + 6) << 2;
        p += 8;
      }
      out.push({flags, index, arg1, arg2, transform: m});
    } while (flags & MORE_COMPONENTS);
    return out;
  }

  /** `TT_Process_Composite_Component`. */
  private processComponent(subglyph: SubGlyph, startPoint: number, basePoints: number): void {
    const outline = this.outline,
      points = outline.points,
      numPoints = outline.nPoints,
      m = subglyph.transform;
    const haveScale =
      (subglyph.flags & (WE_HAVE_A_SCALE | WE_HAVE_AN_XY_SCALE | WE_HAVE_A_2X2)) !== 0;
    if (haveScale) for (let i = basePoints; i < numPoints; i++) transform(points, i * 2, m);
    let x: number, y: number;
    if (!(subglyph.flags & ARGS_ARE_XY_VALUES)) {
      const k = ((subglyph.arg1 >>> 0) + startPoint) >>> 0,
        l = ((subglyph.arg2 >>> 0) + basePoints) >>> 0;
      if (k >= basePoints || l >= numPoints) throw new FontError(FontErrorCode.InvalidComposite);
      x = (points[k * 2]! - points[l * 2]!) | 0;
      y = (points[k * 2 + 1]! - points[l * 2 + 1]!) | 0;
    } else {
      x = subglyph.arg1;
      y = subglyph.arg2;
      if (!x && !y) return;
      if (haveScale && subglyph.flags & SCALED_COMPONENT_OFFSET) {
        const macX = sqrtFixed((mulFix(m.xx, m.xx) + mulFix(m.xy, m.xy)) | 0),
          macY = sqrtFixed((mulFix(m.yy, m.yy) + mulFix(m.yx, m.yx)) | 0);
        x = mulFix(x, macX);
        y = mulFix(y, macY);
      }
      x = mulFix(x, this.xScale);
      y = mulFix(y, this.yScale);
      if (subglyph.flags & ROUND_XY_TO_GRID) {
        x = pixRound(x);
        y = pixRound(y);
      }
    }
    if (x || y) outline.translate(x, y, basePoints);
  }
}
