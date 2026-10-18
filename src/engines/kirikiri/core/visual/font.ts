/**
 * `tTVPFont` (krkrz `visual/tvpfontstruc.h`) and the font rasterizer interface the core draws
 * and measures text with (`visual/FontRasterizer.h`). The rasterizer is a core service: the
 * reference build uses GDI (`TVPCurrentFontRasterizers = FONT_RASTER_GDI`); a host provides
 * an implementation with the same metrics.
 */
import {TjsError} from '../../tjs2/runtime/errors.js';
import type {TvpRect} from './complex-rect.js';

export const TVP_TF_ITALIC = 0x0100;
export const TVP_TF_BOLD = 0x0200;
export const TVP_TF_UNDERLINE = 0x0400;
export const TVP_TF_STRIKEOUT = 0x0800;
export const TVP_TF_FONTFILE = 0x1000;

export const TVP_FSF_FIXEDPITCH = 0x01;
export const TVP_FSF_SAMECHARSET = 0x02;
export const TVP_FSF_NOVERTICAL = 0x04;
export const TVP_FSF_TRUETYPEONLY = 0x08;
export const TVP_FSF_IGNORESYMBOL = 0x10;
export const TVP_FSF_USEFONTFACE = 0x100;

/** `FONT_RASTER_FREE_TYPE`, `FONT_RASTER_GDI`. */
export const FONT_RASTER_FREE_TYPE = 0;
export const FONT_RASTER_GDI = 1;

/** `tTVPFont`. */
export interface TvpFont {
  /** Text height in pixels; the default font's height is −12 (a cell height). */
  height: number;
  flags: number;
  /** Tenths of degrees, 0 … 3599. */
  angle: number;
  face: string;
}

export function copyFont(f: TvpFont): TvpFont {
  return {height: f.height, flags: f.flags, angle: f.angle, face: f.face};
}

export function fontEquals(a: TvpFont, b: TvpFont): boolean {
  return a.height === b.height && a.flags === b.flags && a.angle === b.angle && a.face === b.face;
}

/** Extent of one character (`GetTextExtent`). */
export interface TvpTextExtent {
  readonly width: number;
  readonly height: number;
}

/** `FontRasterizer`: measuring (and, later, glyph rendering) for a selected font. */
export interface TvpFontRasterizer {
  /** `ApplyFont(const tTVPFont&)`. */
  applyFont(font: TvpFont): void;
  /** `GetTextExtent(ch, w, h)` with the applied font. */
  getTextExtent(ch: number): TvpTextExtent;
  /** `GetAscentHeight` of the applied font. */
  getAscentHeight(): number;
  /** `GetGlyphDrawRect(text, area)`. */
  getGlyphDrawRect(text: string, area: TvpRect): void;
  /** `TVPGetFontList(list, flags, font)`. */
  getFontList(flags: number, font: TvpFont): string[];
}

/** The rasterizers of the core (`TVPFontRasterizers`) and the current selection. */
export class TvpFontSystem {
  #current = FONT_RASTER_GDI;
  /** `TVPGlobalFontStateMagic`: changes invalidate applied fonts. */
  stateMagic = 0;

  constructor(
    /** `FontSystem::DefaultFont`: height −12, no flags, the `TVPDefaultFontName` face. */
    readonly defaultFont: TvpFont,
    private readonly rasterizers: readonly (TvpFontRasterizer | null)[] = [null, null],
  ) {}

  get rasterizerIndex(): number {
    return this.#current;
  }

  /** `TVPSetFontRasterizer`. */
  setRasterizer(index: number): void {
    if (this.#current !== index && index >= 0 && index < 2) {
      this.#current = index;
      this.stateMagic++;
    }
  }

  /** `GetCurrentRasterizer`. */
  current(): TvpFontRasterizer {
    const r = this.rasterizers[this.#current];
    if (!r) throw new TjsError('Font rasterizer is not available');
    return r;
  }
}
