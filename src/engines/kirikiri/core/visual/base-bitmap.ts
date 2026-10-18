/**
 * Layer bitmaps: `tTVPBitmap` (shared, reference-counted bits), `tTVPNativeBaseBitmap` and
 * `tTVPBaseBitmap` (krkrz `visual/LayerBitmapImpl.cpp`, `visual/LayerBitmapIntf.cpp`).
 *
 * Bits are bottom-up DIBs in the core's memory (`memory.ts`): scan line `l` starts at
 * `bits + (height − l − 1) × pitchBytes` and the pitch seen by callers (`GetPitchBytes`,
 * `Layer.mainImageBufferPitch`) is negative. 32 bpp rows are `width × 4` bytes, 8 bpp rows are
 * padded to 4 bytes. Bitmaps share bits until written (`Independ`).
 *
 * The pixel work is done by the kernels in `tvpgl.ts`. Stretching, affine transformation, box
 * blur, gamma adjustment and nine-patch copies are not part of this module yet.
 */
import {TjsError, throwTjsError} from '../../tjs2/runtime/errors.js';
import {TvpRect, type TvpComplexRect} from './complex-rect.js';
import {copyFont, type TvpFont, type TvpFontSystem} from './font.js';
import type {TvpMemory} from './memory.js';
import * as gl from './tvpgl.js';

/** `tTVPBBBltMethod`. */
export enum BltMethod {
  bmCopy,
  bmCopyOnAlpha,
  bmAlpha,
  bmAlphaOnAlpha,
  bmAdd,
  bmSub,
  bmMul,
  bmDodge,
  bmDarken,
  bmLighten,
  bmScreen,
  bmAddAlpha,
  bmAddAlphaOnAddAlpha,
  bmAddAlphaOnAlpha,
  bmAlphaOnAddAlpha,
  bmCopyOnAddAlpha,
  bmPsNormal,
  bmPsAdditive,
  bmPsSubtractive,
  bmPsMultiplicative,
  bmPsScreen,
  bmPsOverlay,
  bmPsHardLight,
  bmPsSoftLight,
  bmPsColorDodge,
  bmPsColorDodge5,
  bmPsColorBurn,
  bmPsLighten,
  bmPsDarken,
  bmPsDifference,
  bmPsDifference5,
  bmPsExclusion,
}

export const TVP_BB_COPY_MAIN = 1;
export const TVP_BB_COPY_MASK = 2;

const DEFAULT_PALETTE_COUNT = 256;

/** `tTVPBitmap`: the bits of one or more bitmaps. */
export class TvpBitmap {
  #refCount = 1;
  readonly width: number;
  readonly height: number;
  readonly bpp: number;
  /** Bytes per row (positive); the scan-line step is `-pitchBytes`. */
  readonly pitchBytes: number;
  /** Address of the bits (0 for an empty bitmap). */
  readonly bits: number;
  readonly imageSize: number;
  readonly palette: Uint32Array | null;
  paletteCount = 0;

  constructor(
    readonly memory: TvpMemory,
    width: number,
    height: number,
    bpp: number,
  ) {
    this.width = width;
    this.height = height;
    this.bpp = bpp;
    // BitmapInfomation: 8 bpp rows padded to 4 bytes, 32 bpp rows are width × 4.
    this.pitchBytes = bpp === 8 ? (((width - 1) >> 2) + 1) << 2 : width * 4;
    this.imageSize = this.pitchBytes * height;
    this.bits = this.imageSize > 0 ? memory.allocate(this.imageSize) : 0;
    this.palette = bpp === 8 ? new Uint32Array(DEFAULT_PALETTE_COUNT) : null;
  }

  /** The cloning constructor. */
  static clone(r: TvpBitmap): TvpBitmap {
    const b = new TvpBitmap(r.memory, r.width, r.height, r.bpp);
    if (r.bits) b.memory.u8.copyWithin(b.bits, r.bits, r.bits + r.imageSize);
    if (r.palette && b.palette) {
      b.palette.set(r.palette);
      b.paletteCount = r.paletteCount;
    }
    return b;
  }

  addRef(): void {
    this.#refCount++;
  }

  release(): void {
    if (this.#refCount === 1) {
      this.#refCount = 0;
      if (this.bits) this.memory.free(this.bits, this.imageSize);
    } else this.#refCount--;
  }

  get isIndependent(): boolean {
    return this.#refCount === 1;
  }

  get is32bit(): boolean {
    return this.bpp === 32;
  }

  get is8bit(): boolean {
    return this.bpp === 8;
  }

  /** `GetPitch`: the step to the next (lower) row. */
  get pitch(): number {
    return -this.pitchBytes;
  }

  /** `GetScanLine`: the address of row `l`. */
  scanLine(l: number): number {
    if (l < 0 || l >= this.height)
      throwTjsError('TVPScanLineRangeOver', String(l), String(this.height - 1));
    return this.bits + (this.height - l - 1) * this.pitchBytes;
  }

  /** `SetPaletteCount`. */
  setPaletteCount(count: number): void {
    if (!this.is8bit) throwTjsError('TVPInvalidOperationFor32BPP');
    if (count >= DEFAULT_PALETTE_COUNT) throwTjsError('TJSRangeError');
    this.paletteCount = count;
  }
}

/** `tTVPNativeBaseBitmap` with `tTVPBaseBitmap`. */
export class TvpBaseBitmap {
  bitmap: TvpBitmap;
  #font: TvpFont;
  #fontChanged = true;
  #globalFontState = -1;
  #cachedText: string | null = null;
  #textWidth = 0;
  #textHeight = 0;
  #radianAngle = 0;
  /** Ascent offset of the applied font (`AscentOfsX`/`AscentOfsY`), for text drawing. */
  ascentOfsX = 0;
  ascentOfsY = 0;

  readonly fonts: TvpFontSystem;

  /** `tTVPBaseBitmap(w, h, bpp)`, or the copy constructor (shared bits) given a bitmap. */
  constructor(source: TvpBaseBitmap);
  constructor(fonts: TvpFontSystem, memory: TvpMemory, width: number, height: number, bpp?: number);
  constructor(
    source: TvpFontSystem | TvpBaseBitmap,
    memory?: TvpMemory,
    width = 0,
    height = 0,
    bpp = 32,
  ) {
    if (source instanceof TvpBaseBitmap) {
      this.fonts = source.fonts;
      this.bitmap = source.bitmap;
      this.bitmap.addRef();
      this.#font = copyFont(source.#font);
    } else {
      this.fonts = source;
      this.#font = copyFont(source.defaultFont);
      this.bitmap = new TvpBitmap(memory!, width, height, bpp);
    }
  }

  /** The copy constructor: shares the bits. */
  static from(r: TvpBaseBitmap): TvpBaseBitmap {
    return new TvpBaseBitmap(r);
  }

  /** The destructor. The object must not be used afterwards. */
  dispose(): void {
    this.bitmap.release();
  }

  get memory(): TvpMemory {
    return this.bitmap.memory;
  }

  // --- metrics ---------------------------------------------------------------------------------

  get width(): number {
    return this.bitmap.width;
  }

  get height(): number {
    return this.bitmap.height;
  }

  setWidth(w: number): void {
    this.setSize(w, this.bitmap.height);
  }

  setHeight(h: number): void {
    this.setSize(this.bitmap.width, h);
  }

  /** `SetSize`: a new bitmap; the common part of the image is kept when `keepImage`. */
  setSize(w: number, h: number, keepImage = true): void {
    const old = this.bitmap;
    if (old.width === w && old.height === h) return;
    const nb = new TvpBitmap(old.memory, w, h, old.bpp);
    if (keepImage) {
      const pixelSize = old.is32bit ? 4 : 1;
      const lh = Math.min(h, old.height);
      const cs = Math.min(w, old.width) * pixelSize;
      const u8 = old.memory.u8;
      for (let i = 0; i < lh; i++) {
        const s = old.scanLine(i);
        u8.copyWithin(nb.scanLine(i), s, s + cs);
      }
      if (pixelSize === 1 && nb.palette && old.palette) nb.palette.set(old.palette);
    }
    old.release();
    this.bitmap = nb;
    this.#fontChanged = true;
  }

  get bpp(): number {
    return this.bitmap.bpp;
  }

  get is32BPP(): boolean {
    return this.bitmap.is32bit;
  }

  get is8BPP(): boolean {
    return this.bitmap.is8bit;
  }

  /** `Assign`: shares `rhs`'s bits and font; false when nothing changed. */
  assign(rhs: TvpBaseBitmap): boolean {
    if (this === rhs || this.bitmap === rhs.bitmap) return false;
    this.bitmap.release();
    this.bitmap = rhs.bitmap;
    this.bitmap.addRef();
    this.#font = copyFont(rhs.#font);
    this.#fontChanged = true;
    return true;
  }

  /** `AssignBitmap`: shares `rhs`'s bits only. */
  assignBitmap(rhs: TvpBaseBitmap): boolean {
    if (this === rhs || this.bitmap === rhs.bitmap) return false;
    this.bitmap.release();
    this.bitmap = rhs.bitmap;
    this.bitmap.addRef();
    this.#fontChanged = true;
    return true;
  }

  scanLine(l: number): number {
    return this.bitmap.scanLine(l);
  }

  scanLineForWrite(l: number): number {
    this.independ();
    return this.bitmap.scanLine(l);
  }

  /** `GetPitchBytes`: negative (bottom-up). */
  get pitchBytes(): number {
    return this.bitmap.pitch;
  }

  get isIndependent(): boolean {
    return this.bitmap.isIndependent;
  }

  independ(): void {
    if (this.bitmap.isIndependent) return;
    const nb = TvpBitmap.clone(this.bitmap);
    this.bitmap.release();
    this.bitmap = nb;
    this.#fontChanged = true;
  }

  independNoCopy(): void {
    if (this.bitmap.isIndependent) return;
    this.recreate();
  }

  recreate(w = this.bitmap.width, h = this.bitmap.height, bpp = this.bitmap.bpp): void {
    const memory = this.bitmap.memory;
    this.bitmap.release();
    this.bitmap = new TvpBitmap(memory, w, h, bpp);
    this.#fontChanged = true;
  }

  getPalette(index: number): number {
    if (!this.is8BPP) throwTjsError('TVPInvalidOperationFor32BPP');
    if (index >= this.bitmap.paletteCount) throwTjsError('TJSRangeError');
    return this.bitmap.palette![index]!;
  }

  setPalette(index: number, color: number): void {
    if (!this.is8BPP) throwTjsError('TVPInvalidOperationFor32BPP');
    if (index >= this.bitmap.paletteCount) this.bitmap.setPaletteCount(index + 1);
    this.bitmap.palette![index] = color >>> 0;
  }

  // --- fonts -----------------------------------------------------------------------------------

  get font(): TvpFont {
    return this.#font;
  }

  setFont(font: TvpFont): void {
    this.#font = copyFont(font);
    this.#fontChanged = true;
  }

  /** `ApplyFont`. */
  applyFont(): void {
    const fonts = this.fonts;
    if (this.#fontChanged || this.#globalFontState !== fonts.stateMagic) {
      this.independ();
      this.#fontChanged = false;
      this.#globalFontState = fonts.stateMagic;
      this.#cachedText = null;
      this.#textWidth = this.#textHeight = 0;
      const r = fonts.current();
      r.applyFont(this.#font);
      const ascent = r.getAscentHeight();
      this.#radianAngle = this.#font.angle * (Math.PI / 1800);
      const angle90 = this.#radianAngle + Math.PI / 2;
      this.ascentOfsX = Math.trunc(-Math.cos(angle90) * ascent);
      this.ascentOfsY = Math.trunc(Math.sin(angle90) * ascent);
    } else {
      fonts.current().applyFont(this.#font);
    }
  }

  #getTextSize(text: string): void {
    this.applyFont();
    if (text === this.#cachedText) return;
    this.#cachedText = text;
    const r = this.fonts.current();
    let width = 0;
    for (let i = 0; i < text.length && text.charCodeAt(i) !== 0; i++)
      width += r.getTextExtent(text.charCodeAt(i)).width;
    this.#textWidth = width >>> 0;
    this.#textHeight = Math.abs(this.#font.height);
  }

  getTextWidth(text: string): number {
    this.#getTextSize(text);
    return this.#textWidth;
  }

  getTextHeight(text: string): number {
    this.#getTextSize(text);
    return this.#textHeight;
  }

  getEscWidthX(text: string): number {
    this.#getTextSize(text);
    return Math.cos(this.#radianAngle) * this.#textWidth;
  }

  getEscWidthY(text: string): number {
    this.#getTextSize(text);
    return Math.sin(this.#radianAngle) * -this.#textWidth;
  }

  getEscHeightX(text: string): number {
    this.#getTextSize(text);
    return Math.sin(this.#radianAngle) * this.#textHeight;
  }

  getEscHeightY(text: string): number {
    this.#getTextSize(text);
    return Math.cos(this.#radianAngle) * this.#textHeight;
  }

  getFontGlyphDrawRect(text: string, area: TvpRect): void {
    this.applyFont();
    this.fonts.current().getGlyphDrawRect(text, area);
  }

  getFontList(flags: number): string[] {
    this.applyFont();
    return this.fonts.current().getFontList(flags, this.#font);
  }

  /** `DrawText`: needs the glyph renderer of the rasterizer, which is not available yet. */
  drawText(
    _destrect: TvpRect,
    _x: number,
    _y: number,
    text: string,
    _color: number,
    _bltmode: BltMethod,
    _opa: number,
    _holdalpha: boolean,
    _aa: boolean,
    _shlevel: number,
    _shadowcolor: number,
    _shwidth: number,
    _shofsx: number,
    _shofsy: number,
    _updaterects: TvpComplexRect | null,
  ): void {
    if (!text.length) return;
    this.applyFont();
    throw new TjsError('drawText: glyph rendering is not available');
  }

  // --- pixel access ------------------------------------------------------------------------------

  /** `BOUND_CHECK`: clips `rect` to the bitmap; false when nothing remains. */
  #boundCheck(rect: TvpRect): boolean {
    if (rect.left < 0) rect.left = 0;
    if (rect.top < 0) rect.top = 0;
    if (rect.right > this.width) rect.right = this.width;
    if (rect.bottom > this.height) rect.bottom = this.height;
    return rect.right - rect.left > 0 && rect.bottom - rect.top > 0;
  }

  #checkPoint(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throwTjsError('TVPOutOfRectangle');
  }

  /** `SetSizeWithFill`: resizes and fills the added area with `fillValue`. */
  setSizeWithFill(w: number, h: number, fillValue: number): void {
    const orgw = this.width,
      orgh = this.height;
    this.setSize(w, h);
    if (w > orgw && h > orgh) {
      this.fill(new TvpRect(orgw, 0, w, h), fillValue);
      this.fill(new TvpRect(0, orgh, orgw, h), fillValue);
    } else if (w > orgw) {
      this.fill(new TvpRect(orgw, 0, w, h), fillValue);
    } else if (h > orgh) {
      this.fill(new TvpRect(0, orgh, w, h), fillValue);
    }
  }

  getPoint(x: number, y: number): number {
    this.#checkPoint(x, y);
    const m = this.memory;
    if (this.is32BPP) return m.u32[(this.scanLine(y) >> 2) + x]!;
    return m.u8[this.scanLine(y) + x]!;
  }

  setPoint(x: number, y: number, value: number): boolean {
    this.#checkPoint(x, y);
    const m = this.memory;
    if (this.is32BPP) m.u32[(this.scanLineForWrite(y) >> 2) + x] = value >>> 0;
    else m.u8[this.scanLine(y) + x] = value & 0xff;
    return true;
  }

  setPointMain(x: number, y: number, color: number): boolean {
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    this.#checkPoint(x, y);
    const u32 = this.memory.u32;
    const i = (this.scanLineForWrite(y) >> 2) + x;
    u32[i] = ((u32[i]! & 0xff000000) + (color & 0xffffff)) >>> 0;
    return true;
  }

  setPointMask(x: number, y: number, mask: number): boolean {
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    this.#checkPoint(x, y);
    const u32 = this.memory.u32;
    const i = (this.scanLineForWrite(y) >> 2) + x;
    u32[i] = ((u32[i]! & 0x00ffffff) + ((mask & 0xff) << 24)) >>> 0;
    return true;
  }

  /** Calls `line(rowAddress)` for each row of `rect` (writable), top to bottom. */
  #rows(rect: TvpRect, line: (address: number) => void): void {
    const pitch = this.pitchBytes;
    let sc = this.scanLineForWrite(rect.top);
    for (let y = rect.top; y < rect.bottom; y++, sc += pitch) line(sc);
  }

  /** `Fill`: colour and opacity (`0xAARRGGBB`), or an index for 8 bpp. */
  fill(r: TvpRect, value: number): boolean {
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return false;
    if (
      !this.isIndependent &&
      rect.left === 0 &&
      rect.top === 0 &&
      rect.right === this.width &&
      rect.bottom === this.height
    )
      this.independNoCopy();
    const w = rect.right - rect.left;
    const m = this.memory;
    if (this.is32BPP) this.#rows(rect, (sc) => gl.fillARGB(m.u32, (sc >> 2) + rect.left, w, value));
    else this.#rows(rect, (sc) => m.u8.fill(value & 0xff, sc + rect.left, sc + rect.left + w));
    return true;
  }

  /** `FillColor`: colour with opacity, destination alpha kept. */
  fillColor(r: TvpRect, color: number, opa: number): boolean {
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return false;
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    if (opa === 0) return false;
    opa = Math.min(255, Math.max(0, opa));
    const w = rect.right - rect.left;
    const u32 = this.memory.u32;
    if (opa === 255) this.#rows(rect, (sc) => gl.fillColor(u32, (sc >> 2) + rect.left, w, color));
    else
      this.#rows(rect, (sc) => gl.constColorAlphaBlend(u32, (sc >> 2) + rect.left, w, color, opa));
    return true;
  }

  #blendColor(r: TvpRect, color: number, opa: number, additive: boolean): boolean {
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return false;
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    if (opa === 0) return false;
    opa = Math.min(255, Math.max(0, opa));
    if (
      opa === 255 &&
      !this.isIndependent &&
      rect.left === 0 &&
      rect.top === 0 &&
      rect.right === this.width &&
      rect.bottom === this.height
    )
      this.independNoCopy();
    const w = rect.right - rect.left;
    const u32 = this.memory.u32;
    if (opa === 255) {
      const c = (color | 0xff000000) >>> 0;
      this.#rows(rect, (sc) => gl.fillARGB(u32, (sc >> 2) + rect.left, w, c));
    } else if (!additive) {
      this.#rows(rect, (sc) => gl.constColorAlphaBlendD(u32, (sc >> 2) + rect.left, w, color, opa));
    } else {
      this.#rows(rect, (sc) => gl.constColorAlphaBlendA(u32, (sc >> 2) + rect.left, w, color, opa));
    }
    return true;
  }

  fillColorOnAlpha(rect: TvpRect, color: number, opa: number): boolean {
    return this.#blendColor(rect, color, opa, false);
  }

  fillColorOnAddAlpha(rect: TvpRect, color: number, opa: number): boolean {
    return this.#blendColor(rect, color, opa, true);
  }

  removeConstOpacity(r: TvpRect, level: number): boolean {
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return false;
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    if (level === 0) return false;
    level = Math.min(255, Math.max(0, level));
    const w = rect.right - rect.left;
    const u32 = this.memory.u32;
    if (level === 255) this.#rows(rect, (sc) => gl.fillMask(u32, (sc >> 2) + rect.left, w, 0));
    else this.#rows(rect, (sc) => gl.removeConstOpacity(u32, (sc >> 2) + rect.left, w, level));
    return true;
  }

  fillMask(r: TvpRect, value: number): boolean {
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return false;
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    const w = rect.right - rect.left;
    const u32 = this.memory.u32;
    this.#rows(rect, (sc) => gl.fillMask(u32, (sc >> 2) + rect.left, w, value & 0xff));
    return true;
  }

  /**
   * Clips a transfer of `refrect` from `ref` to (`x`, `y`) against both bitmaps. Returns the
   * destination rectangle, with `refrect` adjusted, or null when nothing is drawable.
   */
  #clipTransfer(x: number, y: number, ref: TvpBaseBitmap, refrect: TvpRect): TvpRect | null {
    let bmpw = ref.width,
      bmph = ref.height;
    if (refrect.left < 0) {
      x -= refrect.left;
      refrect.left = 0;
    }
    if (refrect.right > bmpw) refrect.right = bmpw;
    if (refrect.left >= refrect.right) return null;
    if (refrect.top < 0) {
      y -= refrect.top;
      refrect.top = 0;
    }
    if (refrect.bottom > bmph) refrect.bottom = bmph;
    if (refrect.top >= refrect.bottom) return null;
    bmpw = this.width;
    bmph = this.height;
    const rect = new TvpRect(x, y, x + refrect.width, y + refrect.height);
    if (rect.left < 0) {
      refrect.left += -rect.left;
      rect.left = 0;
    }
    if (rect.right > bmpw) {
      refrect.right -= rect.right - bmpw;
      rect.right = bmpw;
    }
    if (refrect.left >= refrect.right) return null;
    if (rect.top < 0) {
      refrect.top += -rect.top;
      rect.top = 0;
    }
    if (rect.bottom > bmph) {
      refrect.bottom -= rect.bottom - bmph;
      rect.bottom = bmph;
    }
    if (refrect.top >= refrect.bottom) return null;
    return rect;
  }

  /**
   * `CopyRect`: copies `refrect` of `ref` to (`x`, `y`); `plane` selects main and mask
   * (ignored for 8 bpp). Overlapping copies within one bitmap are handled.
   */
  copyRect(
    x: number,
    y: number,
    ref: TvpBaseBitmap,
    r: TvpRect,
    plane = TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK,
  ): boolean {
    const refrect = TvpRect.from(r);
    if (!this.is32BPP) plane = TVP_BB_COPY_MASK | TVP_BB_COPY_MAIN;
    if (
      x === 0 &&
      y === 0 &&
      refrect.left === 0 &&
      refrect.top === 0 &&
      refrect.right === ref.width &&
      refrect.bottom === ref.height &&
      this.width === refrect.right &&
      this.height === refrect.bottom &&
      plane === (TVP_BB_COPY_MASK | TVP_BB_COPY_MAIN) &&
      !this.is32BPP === !ref.is32BPP
    ) {
      this.assignBitmap(ref);
      return true;
    }
    const rect = this.#clipTransfer(x, y, ref, refrect);
    if (!rect) return false;
    const dest = this.scanLineForWrite(0);
    const src = ref.scanLine(0);
    const dpitch = this.pitchBytes,
      spitch = ref.pitchBytes;
    const w = refrect.width,
      h = refrect.height;
    const pixelSize = this.is32BPP ? 4 : 1;
    const backward = ref === this && rect.top > refrect.top;
    const m = this.memory;
    const rowD = (i: number) => dest + dpitch * (rect.top + i) + rect.left * pixelSize;
    const rowS = (i: number) => src + spitch * (refrect.top + i) + refrect.left * pixelSize;
    const copyRow = (d: number, s: number) => {
      switch (plane) {
        case TVP_BB_COPY_MAIN:
          gl.copyColor(m.u32, d >> 2, s >> 2, w);
          break;
        case TVP_BB_COPY_MASK:
          gl.copyMask(m.u32, d >> 2, s >> 2, w);
          break;
        default:
          m.u8.copyWithin(d, s, s + w * pixelSize);
      }
    };
    if (backward) for (let i = h - 1; i >= 0; i--) copyRow(rowD(i), rowS(i));
    else for (let i = 0; i < h; i++) copyRow(rowD(i), rowS(i));
    return true;
  }

  /**
   * `Blt`: blends `refrect` of `ref` at (`x`, `y`) with `method` and opacity `opa`. `hda`
   * keeps the destination alpha.
   */
  blt(
    x: number,
    y: number,
    ref: TvpBaseBitmap,
    r: TvpRect,
    method: BltMethod,
    opa: number,
    hda = true,
  ): boolean {
    if (opa === 255 && method === BltMethod.bmCopy && !hda) return this.copyRect(x, y, ref, r);
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    if (opa === 0) return false;
    const refrect = TvpRect.from(r);
    const rect = this.#clipTransfer(x, y, ref, refrect);
    if (!rect) return false;
    const dest = this.scanLineForWrite(0);
    const src = ref.scanLine(0);
    const dpitch = this.pitchBytes,
      spitch = ref.pitchBytes;
    const w = refrect.width,
      h = refrect.height;
    const u32 = this.memory.u32;
    const kernel = bltKernel(method, opa, hda);
    let d = dest + rect.top * dpitch + rect.left * 4;
    let s = src + refrect.top * spitch + refrect.left * 4;
    for (let i = 0; i < h; i++, d += dpitch, s += spitch) kernel(u32, d >> 2, s >> 2, w, opa);
    return true;
  }

  // --- whole-image operations ------------------------------------------------------------------

  udFlip(rect: TvpRect): void {
    if (rect.left < 0 || rect.top < 0 || rect.right > this.width || rect.bottom > this.height)
      throwTjsError('TVPSrcRectOutOfBitmap');
    let h = (rect.bottom - rect.top) >> 1;
    const w = rect.right - rect.left;
    const pitch = this.pitchBytes;
    let l1 = this.scanLineForWrite(rect.top);
    let l2 = this.scanLineForWrite(rect.bottom - 1);
    const m = this.memory;
    if (this.is32BPP) {
      l1 += rect.left * 4;
      l2 += rect.left * 4;
      while (h--) {
        gl.swapLine32(m.u32, l1 >> 2, l2 >> 2, w);
        l1 += pitch;
        l2 -= pitch;
      }
    } else {
      l1 += rect.left;
      l2 += rect.left;
      while (h--) {
        gl.swapLine8(m.u8, l1, l2, w);
        l1 += pitch;
        l2 -= pitch;
      }
    }
  }

  lrFlip(rect: TvpRect): void {
    if (rect.left < 0 || rect.top < 0 || rect.right > this.width || rect.bottom > this.height)
      throwTjsError('TVPSrcRectOutOfBitmap');
    const w = rect.right - rect.left;
    const m = this.memory;
    if (this.is32BPP) this.#rows(rect, (line) => gl.reverse32(m.u32, (line >> 2) + rect.left, w));
    else this.#rows(rect, (line) => gl.reverse8(m.u8, line + rect.left, w));
  }

  doGrayScale(r: TvpRect): void {
    if (!this.is32BPP) return;
    const rect = TvpRect.from(r);
    if (!this.#boundCheck(rect)) return;
    const w = rect.right - rect.left;
    const u32 = this.memory.u32;
    this.#rows(rect, (line) => gl.doGrayScale(u32, (line >> 2) + rect.left, w));
  }

  convertAddAlphaToAlpha(): void {
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    const w = this.width;
    const u32 = this.memory.u32;
    this.#rows(new TvpRect(0, 0, w, this.height), (line) =>
      gl.convertAddAlphaToAlpha(u32, line >> 2, w),
    );
  }

  convertAlphaToAddAlpha(): void {
    if (!this.is32BPP) throwTjsError('TVPInvalidOperationFor8BPP');
    const w = this.width;
    const u32 = this.memory.u32;
    this.#rows(new TvpRect(0, 0, w, this.height), (line) =>
      gl.convertAlphaToAddAlpha(u32, line >> 2, w),
    );
  }
}

type Kernel = (m: Uint32Array, dest: number, src: number, len: number, opa: number) => void;

/** `TVP_BLEND_4`: the normal, opacity, HDA and HDA-opacity variants of a blend. */
function blend4(opa: number, hda: boolean, n: Kernel, o: Kernel, h: Kernel, ho: Kernel): Kernel {
  if (opa === 255) return hda ? h : n;
  return hda ? ho : o;
}

function notPorted(name: string): Kernel {
  return () => {
    throw new TjsError(`${name}: the blend kernel is not available`);
  };
}

/** The line kernel of `PartialBlt` for `method`. */
function bltKernel(method: BltMethod, opa: number, hda: boolean): Kernel {
  switch (method) {
    case BltMethod.bmCopy:
      if (opa === 255 && hda) return (m, d, s, len) => gl.copyColor(m, d, s, len);
      return hda ? gl.TVPConstAlphaBlend_HDA : gl.TVPConstAlphaBlend;
    case BltMethod.bmCopyOnAlpha:
      return opa === 255
        ? (m, d, s, len) => gl.copyOpaqueImage(m, d, s, len)
        : gl.TVPConstAlphaBlend_d;
    case BltMethod.bmAlpha:
      return blend4(
        opa,
        hda,
        gl.TVPAlphaBlend,
        gl.TVPAlphaBlend_o,
        gl.TVPAlphaBlend_HDA,
        gl.TVPAlphaBlend_HDA_o,
      );
    case BltMethod.bmAlphaOnAlpha:
      return opa === 255 ? gl.TVPAlphaBlend_d : gl.TVPAlphaBlend_do;
    case BltMethod.bmAddAlpha:
      return blend4(
        opa,
        hda,
        gl.TVPAdditiveAlphaBlend,
        gl.TVPAdditiveAlphaBlend_o,
        gl.TVPAdditiveAlphaBlend_HDA,
        gl.TVPAdditiveAlphaBlend_HDA_o,
      );
    case BltMethod.bmAddAlphaOnAddAlpha:
      return opa === 255 ? gl.TVPAdditiveAlphaBlend_a : gl.TVPAdditiveAlphaBlend_ao;
    case BltMethod.bmAddAlphaOnAlpha:
      // Not implemented natively: nothing is drawn.
      return () => {};
    case BltMethod.bmAlphaOnAddAlpha:
      return opa === 255 ? gl.TVPAlphaBlend_a : gl.TVPAlphaBlend_ao;
    case BltMethod.bmCopyOnAddAlpha:
      return opa === 255
        ? (m, d, s, len) => gl.copyOpaqueImage(m, d, s, len)
        : gl.TVPConstAlphaBlend_a;
    default:
      return notPorted(`Blt method ${method}`);
  }
}
