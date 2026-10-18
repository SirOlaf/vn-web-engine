/**
 * `Font` (krkrz `visual/LayerIntf.cpp`, `tTJSNI_Font`). A Font object either belongs to a layer
 * (`layer.font`: every member goes to the layer) or stands alone with its own `tTVPFont`.
 */
import {throwTjsError} from '../../tjs2/runtime/errors.js';
import {TJS_MEMBERENSURE, TJS_S_OK, type Dispatch} from '../../tjs2/runtime/interface.js';
import {
  NativeClass,
  NativeInstanceBase,
  constructNativeInstance,
} from '../../tjs2/runtime/native.js';
import {asObject, bool, int, obj, real, str, type Variant} from '../../tjs2/runtime/variant.js';
import {TvpRect} from '../visual/complex-rect.js';
import {
  TVP_TF_BOLD,
  TVP_TF_FONTFILE,
  TVP_TF_ITALIC,
  TVP_TF_STRIKEOUT,
  TVP_TF_UNDERLINE,
  copyFont,
  type TvpFont,
  type TvpFontSystem,
} from '../visual/font.js';
import {layerOf, type LayerNI} from '../visual/layer.js';
import {Binder, flag, i32, text, u32} from './binding.js';
import {createRectObject} from './rect.js';

/** `tTJSNI_Font`. */
export class FontNI extends NativeInstanceBase {
  #font: TvpFont;
  layer: LayerNI | null = null;

  constructor(private readonly fonts: TvpFontSystem) {
    super();
    this.#font = copyFont(fonts.defaultFont);
  }

  override construct(args: readonly Variant[]): number {
    if (args.length >= 1) {
      const lay = layerOf(asObject(args[0]!));
      if (!lay) throwTjsError('TVPSpecifyLayer');
      this.layer = lay;
    } else {
      this.layer = null;
      this.#font = copyFont(this.fonts.defaultFont);
    }
    return TJS_S_OK;
  }

  override invalidate(): void {
    this.layer = null;
  }

  get font(): TvpFont {
    return this.layer ? this.layer.font : this.#font;
  }

  setFace(face: string): void {
    if (this.layer) this.layer.setFontFace(face);
    else this.#font.face = face;
  }

  setHeight(height: number): void {
    if (this.layer) this.layer.setFontHeight(height);
    else this.#font.height = height < 0 ? -height : height;
  }

  setAngle(angle: number): void {
    if (this.layer) this.layer.setFontAngle(angle);
    else if (this.#font.angle !== angle) {
      angle %= 3600;
      if (angle < 0) angle += 3600;
      this.#font.angle = angle;
    }
  }

  setFlag(f: number, b: boolean, onLayer: (l: LayerNI, b: boolean) => void): void {
    if (this.layer) onLayer(this.layer, b);
    else if (((this.#font.flags & f) !== 0) !== b) {
      this.#font.flags &= ~f;
      if (b) this.#font.flags |= f;
    }
  }

  /** `GetTextWidthDirect`. */
  #textWidthDirect(t: string): number {
    const r = this.fonts.current();
    r.applyFont(this.#font);
    let width = 0;
    for (let i = 0; i < t.length && t.charCodeAt(i) !== 0; i++)
      width += r.getTextExtent(t.charCodeAt(i)).width;
    return width >>> 0;
  }

  getTextWidth(t: string): number {
    return this.layer ? this.layer.getTextWidth(t) : this.#textWidthDirect(t);
  }

  getTextHeight(t: string): number {
    return this.layer ? this.layer.getTextHeight(t) : Math.abs(this.#font.height);
  }

  #rad(): number {
    return this.#font.angle * (Math.PI / 1800);
  }

  getEscWidthX(t: string): number {
    return this.layer
      ? this.layer.getEscWidthX(t)
      : Math.cos(this.#rad()) * this.#textWidthDirect(t);
  }

  getEscWidthY(t: string): number {
    return this.layer
      ? this.layer.getEscWidthY(t)
      : Math.sin(this.#rad()) * -this.#textWidthDirect(t);
  }

  getEscHeightX(t: string): number {
    return this.layer
      ? this.layer.getEscHeightX(t)
      : Math.sin(this.#rad()) * Math.abs(this.#font.height);
  }

  getEscHeightY(t: string): number {
    return this.layer
      ? this.layer.getEscHeightY(t)
      : Math.cos(this.#rad()) * Math.abs(this.#font.height);
  }

  getGlyphDrawRect(t: string): TvpRect {
    const area = new TvpRect();
    if (this.layer) this.layer.getFontGlyphDrawRect(t, area);
    else {
      const r = this.fonts.current();
      r.applyFont(this.#font);
      r.getGlyphDrawRect(t, area);
    }
    return area;
  }

  getFontList(flags: number): string[] {
    if (this.layer) return this.layer.getFontList(flags);
    return this.fonts.current().getFontList(flags, this.#font);
  }
}

export function createFontClass(
  fonts: TvpFontSystem,
  createArray: () => Dispatch,
  rectClass: () => NativeClass,
): NativeClass {
  const cls = new NativeClass('Font', () => new FontNI(fonts));
  const b = new Binder<FontNI>(cls);
  cls.emptyFinalize();
  cls.constructorMethod((_result, args, objthis) => {
    const r = constructNativeInstance(cls, args, objthis);
    return typeof r === 'number' ? r : TJS_S_OK;
  });
  b.method('getTextWidth', 1, (ni, a, r) => void r?.set(int(ni.getTextWidth(text(a[0]!)))));
  b.method('getTextHeight', 1, (ni, a, r) => void r?.set(int(ni.getTextHeight(text(a[0]!)))));
  b.method('getEscWidthX', 1, (ni, a, r) => void r?.set(real(ni.getEscWidthX(text(a[0]!)))));
  b.method('getEscWidthY', 1, (ni, a, r) => void r?.set(real(ni.getEscWidthY(text(a[0]!)))));
  b.method('getEscHeightX', 1, (ni, a, r) => void r?.set(real(ni.getEscHeightX(text(a[0]!)))));
  b.method('getEscHeightY', 1, (ni, a, r) => void r?.set(real(ni.getEscHeightY(text(a[0]!)))));
  b.method('getGlyphDrawRect', 1, (ni, a, r) => {
    if (!r) return;
    const rect = ni.getGlyphDrawRect(text(a[0]!));
    const o = createRectObject(rectClass(), rect);
    r.set(obj(o, o));
    o.release();
  });
  b.method('getList', 1, (ni, a, r) => {
    const list = ni.getFontList(u32(a[0]!));
    if (!r) return;
    const arr = createArray();
    r.set(obj(arr, arr));
    arr.release();
    list.forEach((name, i) => arr.propSetByNum(TJS_MEMBERENSURE, i, str(name), arr));
  });
  b.method('mapPrerenderedFont', 1, () => throwTjsError('TVPInternalError'));
  b.method('unmapPrerenderedFont', 0, () => throwTjsError('TVPInternalError'));
  b.prop(
    'face',
    (ni) => str(ni.font.face),
    (ni, v) => ni.setFace(text(v)),
  );
  b.prop(
    'height',
    (ni) => int(ni.font.height),
    (ni, v) => ni.setHeight(i32(v)),
  );
  const flagProp = (name: string, f: number, onLayer: (l: LayerNI, b: boolean) => void) =>
    b.prop(
      name,
      (ni) => bool((ni.font.flags & f) !== 0),
      (ni, v) => ni.setFlag(f, flag(v), onLayer),
    );
  flagProp('bold', TVP_TF_BOLD, (l, v) => l.setFontBold(v));
  flagProp('italic', TVP_TF_ITALIC, (l, v) => l.setFontItalic(v));
  flagProp('strikeout', TVP_TF_STRIKEOUT, (l, v) => l.setFontStrikeout(v));
  flagProp('underline', TVP_TF_UNDERLINE, (l, v) => l.setFontUnderline(v));
  b.prop(
    'angle',
    (ni) => int(ni.font.angle),
    (ni, v) => ni.setAngle(i32(v)),
  );
  flagProp('faceIsFileName', TVP_TF_FONTFILE, (l, v) => l.setFontFaceIsFileName(v));
  b.prop(
    'rasterizer',
    () => int(fonts.rasterizerIndex),
    (_ni, v) => fonts.setRasterizer(i32(v)),
  );
  return cls;
}
