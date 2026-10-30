/** A scalable font face with the observable behavior of FreeType 2.4.8 loading glyphs with
 * `FT_LOAD_RENDER | FT_LOAD_NO_HINTING`: driver selection (TrueType, then CFF), the default
 * Unicode charmap, `FT_Request_Size`, the smooth renderer and `FT_GlyphSlot_Embolden`.
 */
import {defaultCharmap, type CharIndex} from './cmap.js';
import {CffOutlines} from './cff.js';
import {divFix, mulDiv, mulFix, pixCeil, pixFloor, pixRound} from './fixed.js';
import {Outline} from './outline.js';
import {JsOutlineRasterizer, type OutlineRasterizer} from './raster.js';
import {OutlineRasterWasm} from './raster-wasm.js';
import {FontError, FontErrorCode, Sfnt, tag} from './sfnt.js';
import {TrueTypeOutlines} from './truetype.js';

export interface FaceMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  readonly maxAdvanceWidth: number;
  readonly maxAdvanceHeight: number;
  readonly glyphCount: number;
  readonly faceCount: number;
  readonly xPpem: number;
  readonly yPpem: number;
  readonly scaledAscender: number;
  readonly scaledDescender: number;
  readonly scaledHeight: number;
  readonly scaledMaxAdvance: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
}

/** An 8-bit coverage bitmap, top-down rows of `width` bytes. */
export interface RenderedGlyph {
  readonly glyphIndex: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advanceX: number;
  readonly pixels: Uint8Array;
}

/** Size request types of `FT_Size_Request_Type`. */
export const enum SizeRequestType {
  Nominal = 0,
  RealDim = 1,
  BBox = 2,
  Cell = 3,
  Scales = 4,
}

export class OutlineFace {
  private readonly sfnt: Sfnt;
  private readonly truetype: TrueTypeOutlines | null = null;
  private readonly cff: CffOutlines | null = null;
  private readonly charIndex: CharIndex | null;
  private readonly unitsPerEm: number;
  private readonly glyphCount: number;
  private readonly faceCount: number;
  // FT_Size_Metrics of face->size.
  private xPpem = 0;
  private yPpem = 0;
  private xScale = 0;
  private yScale = 0;
  private ascender = 0;
  private descender = 0;
  private height = 0;
  private maxAdvance = 0;
  /** `TT_Size.ttmetrics.valid`. */
  private sizeValid = false;
  private readonly outline = new Outline();
  private readonly raster: OutlineRasterizer;

  /** `wasm: false` selects the JavaScript rasterizer; output is identical. */
  constructor(data: Uint8Array, faceIndex = 0, options: {wasm?: boolean} = {}) {
    this.raster =
      (options.wasm === false ? null : OutlineRasterWasm.create()) ?? new JsOutlineRasterizer();
    const sfnt = (this.sfnt = new Sfnt(data, faceIndex));
    const format = sfnt.formatTag;
    if (format === 0x00010000 || format === 0x00020000 || format === tag('true')) {
      this.truetype = new TrueTypeOutlines(sfnt);
      this.glyphCount = sfnt.numGlyphs;
    } else if (format === tag('OTTO')) {
      if (faceIndex > 0) throw new FontError(FontErrorCode.InvalidArgument);
      this.cff = new CffOutlines(sfnt);
      this.glyphCount = this.cff.numGlyphs;
    } else throw new FontError(FontErrorCode.UnknownFileFormat);
    this.unitsPerEm = sfnt.unitsPerEm;
    this.faceCount = sfnt.faceCount;
    this.charIndex = defaultCharmap(sfnt.bytes, sfnt.cmap);
  }

  /** Whether glyphs rasterize in WebAssembly. */
  get accelerated(): boolean {
    return this.raster instanceof OutlineRasterWasm;
  }

  get metrics(): FaceMetrics {
    const s = this.sfnt;
    return {
      unitsPerEm: this.unitsPerEm,
      ascender: s.ascender,
      descender: s.descender,
      height: s.height,
      maxAdvanceWidth: s.maxAdvanceWidth,
      maxAdvanceHeight: s.maxAdvanceHeight,
      glyphCount: this.glyphCount,
      faceCount: this.faceCount,
      xPpem: this.xPpem,
      yPpem: this.yPpem,
      scaledAscender: this.ascender,
      scaledDescender: this.descender,
      scaledHeight: this.height,
      scaledMaxAdvance: this.maxAdvance,
      underlinePosition: s.underlinePosition,
      underlineThickness: s.underlineThickness,
    };
  }

  /** `FT_Get_Char_Index` (0 when the face has no Unicode charmap). */
  glyphIndex(codePoint: number): number {
    return this.charIndex ? this.charIndex(codePoint) : 0;
  }

  /** `FT_Request_Size` with zero resolutions: `width`/`height` are 26.6 pixel sizes. */
  requestSize(type: SizeRequestType, width: number, height: number): void {
    if (width < 0 || height < 0 || type < 0 || type >= 5)
      throw new FontError(FontErrorCode.InvalidArgument);
    this.requestMetrics(type, width, height);
    if (!this.truetype) {
      if (this.cff) this.cff.setScale(this.xScale, this.yScale);
      return;
    }
    // tt_size_reset
    this.sizeValid = false;
    if (this.xPpem < 1 || this.yPpem < 1) throw new FontError(FontErrorCode.InvalidPPem);
    const s = this.sfnt;
    if (s.headFlags & 8) {
      this.xScale = divFix(this.xPpem << 6, this.unitsPerEm);
      this.yScale = divFix(this.yPpem << 6, this.unitsPerEm);
      this.ascender = pixRound(mulFix(s.ascender, this.yScale));
      this.descender = pixRound(mulFix(s.descender, this.yScale));
      this.height = pixRound(mulFix(s.height, this.yScale));
      this.maxAdvance = pixRound(mulFix(s.maxAdvanceWidth, this.xScale));
    }
    this.sizeValid = true;
  }

  /** `FT_Request_Metrics` + `ft_recompute_scaled_metrics` (GRID_FIT_METRICS). */
  private requestMetrics(type: SizeRequestType, width: number, height: number): void {
    const s = this.sfnt;
    let w = 0,
      h = 0,
      scaledW = 0,
      scaledH = 0;
    if (type === SizeRequestType.Scales) {
      this.xScale = width | 0;
      this.yScale = height | 0;
      if (!this.xScale) this.xScale = this.yScale;
      else if (!this.yScale) this.yScale = this.xScale;
    } else {
      if (type === SizeRequestType.Nominal) w = h = this.unitsPerEm;
      else if (type === SizeRequestType.RealDim) w = h = s.ascender - s.descender;
      else if (type === SizeRequestType.BBox) {
        w = s.bbox[2] - s.bbox[0];
        h = s.bbox[3] - s.bbox[1];
      } else {
        w = s.maxAdvanceWidth;
        h = s.ascender - s.descender;
      }
      if (w < 0) w = -w;
      if (h < 0) h = -h;
      scaledW = width;
      scaledH = height;
      if (width) {
        this.xScale = divFix(scaledW, w);
        if (height) {
          this.yScale = divFix(scaledH, h);
          if (type === SizeRequestType.Cell) {
            if (this.yScale > this.xScale) this.yScale = this.xScale;
            else this.xScale = this.yScale;
          }
        } else {
          this.yScale = this.xScale;
          scaledH = mulDiv(scaledW, h, w);
        }
      } else {
        this.xScale = this.yScale = divFix(scaledH, h);
        scaledW = mulDiv(scaledH, w, h);
      }
    }
    if (type !== SizeRequestType.Nominal) {
      scaledW = mulFix(this.unitsPerEm, this.xScale);
      scaledH = mulFix(this.unitsPerEm, this.yScale);
    }
    this.xPpem = ((scaledW + 32) >> 6) & 0xffff;
    this.yPpem = ((scaledH + 32) >> 6) & 0xffff;
    this.ascender = pixCeil(mulFix(s.ascender, this.yScale));
    this.descender = pixFloor(mulFix(s.descender, this.yScale));
    this.height = pixRound(mulFix(s.height, this.yScale));
    this.maxAdvance = pixRound(mulFix(s.maxAdvanceWidth, this.xScale));
  }

  /** `FT_Load_Char(face, codePoint, FT_LOAD_RENDER | FT_LOAD_NO_HINTING)`, then
   * `FT_GlyphSlot_Embolden` when `bold` is set. `accept` sees the final bitmap size before any
   * pixel is allocated and may throw to refuse it.
   */
  render(
    codePoint: number,
    bold: boolean,
    accept?: (width: number, height: number) => void,
  ): RenderedGlyph {
    const charIndex = this.charIndex;
    const index = charIndex ? charIndex(codePoint) : codePoint >>> 0;
    const outline = this.outline;
    let advance: number;
    if (this.truetype) {
      if (index >= this.glyphCount) throw new FontError(FontErrorCode.InvalidArgument);
      if (!this.sizeValid) throw new FontError(FontErrorCode.InvalidSizeHandle);
      advance = this.truetype.load(outline, index, this.xScale, this.yScale);
    } else advance = this.cff!.load(outline, index);
    outline.check();
    // ft_smooth_render_generic
    const n = outline.nPoints,
      v = outline.points;
    let xMin = 0,
      yMin = 0,
      xMax = 0,
      yMax = 0;
    if (n > 0) {
      xMin = xMax = v[0]!;
      yMin = yMax = v[1]!;
      for (let i = 2; i < n * 2; i += 2) {
        const x = v[i]!,
          y = v[i + 1]!;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    xMin = pixFloor(xMin);
    yMin = pixFloor(yMin);
    xMax = pixCeil(xMax);
    yMax = pixCeil(yMax);
    if ((xMin < 0 && xMax > 0x7fffffff + xMin) || (yMin < 0 && yMax > 0x7fffffff + yMin))
      throw new FontError(FontErrorCode.RasterOverflow);
    const width = ((xMax - xMin) >>> 6) >>> 0,
      height = ((yMax - yMin) >>> 6) >>> 0;
    if (width > 0x7fff || height > 0x7fff) throw new FontError(FontErrorCode.RasterOverflow);
    outline.translate(-xMin, -yMin);
    let glyphWidth = width,
      glyphHeight = height,
      top = yMax >> 6,
      xstr = 0,
      ystr = 0;
    if (bold && width * height) {
      xstr = (mulFix(this.unitsPerEm, this.yScale) / 24) | 0;
      ystr = xstr & ~63;
      xstr &= ~63;
      if (xstr === 0) xstr = 64;
      glyphWidth += xstr >> 6;
      glyphHeight += ystr >> 6;
      if (advance) advance = (advance + xstr) | 0;
      top += ystr >> 6;
    }
    accept?.(glyphWidth, glyphHeight);
    const pixels = this.raster.render(outline, width, height, xstr >> 6, ystr >> 6);
    return {
      glyphIndex: charIndex ? index : 0,
      width: glyphWidth,
      height: glyphHeight,
      left: xMin >> 6,
      top,
      advanceX: advance,
      pixels,
    };
  }
}
