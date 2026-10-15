/**
 * PackinOne's `layerExBTOA` (wamsoft layerExBTOA as of 2014-04-17): alpha and province
 * functions attached to `Layer` (`NCB_ATTACH_FUNCTION`): blue channel to alpha
 * (`copyRightBlueToLeftAlpha`, `copyBottomBlueToTopAlpha`), `fillAlpha`, `copyAlphaToProvince`,
 * `clipAlphaRect` and `fillByProvince`. Layer state is read through the `Layer` class's
 * property objects; every function updates the rectangle it changed.
 *
 * As natively, `copyRightBlueToLeftAlpha` and `copyBottomBlueToTopAlpha` update `(0, 0, w, h)`
 * with the halved size, and `clipAlphaRect` returns `false` (not an error code) when a buffer
 * property cannot be read.
 */
import {ncbInt} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asInteger, asObject} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  failed,
  TJS_E_BADPARAMCOUNT,
  TJS_E_INVALIDPARAM,
  TJS_S_OK,
  type Dispatch,
  type TvpFunctionExporter,
} from '../tvp-plugin/contract.js';
import {updateLayer} from './layer-access.js';
import type {RawFunction} from './system-ex.js';

interface Size {
  w: number;
  h: number;
  pitch: number;
}

export function layerBtoaFunctions(
  ex: TvpFunctionExporter,
  memory: () => Uint8Array,
): [string, RawFunction][] {
  const layerClass = (): Dispatch | null => {
    const v = new VariantSlot();
    ex.TVPExecuteExpression('Layer', null, v);
    const o = asObject(v.value);
    v.clear();
    return o;
  };
  /** `layerClass->PropGet(0, name, &val, lay)`: null when the get fails. */
  const prop = (lay: Dispatch, name: string): number | null => {
    const cls = layerClass();
    const v = new VariantSlot();
    if (!cls || failed(cls.propGet(0, name, v, lay))) {
      v.clear();
      return null;
    }
    const n = v.value.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(v.value)));
    v.clear();
    return n;
  };
  /** `IsInstanceOf` fails only for a broken object; `S_FALSE` passes. */
  const isLayerObject = (lay: Dispatch | null): lay is Dispatch =>
    !!lay && !failed(lay.isInstanceOf(0, null, 'Layer', lay));
  const layerSize = (lay: Dispatch | null): Size | null => {
    if (!isLayerObject(lay)) return null;
    const has = prop(lay, 'hasImage');
    if (!has) return null;
    const w = prop(lay, 'imageWidth');
    const h = prop(lay, 'imageHeight');
    const pitch = prop(lay, 'mainImageBufferPitch');
    if (w === null || h === null || pitch === null) return null;
    return w > 0 && h > 0 && pitch !== 0 ? {w, h, pitch} : null;
  };
  const clipSize = (lay: Dispatch | null): (Size & {l: number; t: number}) | null => {
    if (!isLayerObject(lay)) return null;
    if (!prop(lay, 'hasImage')) return null;
    const l = prop(lay, 'clipLeft');
    const t = prop(lay, 'clipTop');
    const w = prop(lay, 'clipWidth');
    const h = prop(lay, 'clipHeight');
    const pitch = prop(lay, 'mainImageBufferPitch');
    if (l === null || t === null || w === null || h === null || pitch === null) return null;
    return w > 0 && h > 0 && pitch !== 0 ? {l, t, w, h, pitch} : null;
  };
  const writeBuffer = (lay: Dispatch): number | null => {
    const p = prop(lay, 'mainImageBufferForWrite');
    return p ? p >>> 0 : null;
  };

  const blueToAlpha =
    (horizontal: boolean): RawFunction =>
    (_result, _args, lay) => {
      const size = layerSize(lay);
      const base = size ? writeBuffer(lay) : null;
      if (!size || base === null) return ex.TVPThrowExceptionMessage('dest must be Layer.');
      let {w, h} = size;
      const pitch = size.pitch;
      if (horizontal) w = Math.trunc(w / 2);
      else h = Math.trunc(h / 2);
      const u8 = memory();
      let s = horizontal ? base + w * 4 : base + h * pitch;
      let d = base + 3;
      for (let i = 0; i < h; i++, s += pitch, d += pitch)
        for (let j = 0; j < w; j++) u8[d + j * 4] = u8[s + j * 4]!;
      updateLayer(lay, 0, 0, w, h);
      return TJS_S_OK;
    };

  return [
    ['copyRightBlueToLeftAlpha', blueToAlpha(true)],
    ['copyBottomBlueToTopAlpha', blueToAlpha(false)],
    [
      'fillAlpha',
      (_result, _args, lay) => {
        const c = clipSize(lay);
        const base = c ? writeBuffer(lay) : null;
        if (!c || base === null) return ex.TVPThrowExceptionMessage('dest must be Layer.');
        const u8 = memory();
        let d = base + c.pitch * c.t + c.l * 4 + 3;
        for (let i = 0; i < c.h; i++, d += c.pitch)
          for (let j = 0; j < c.w; j++) u8[d + j * 4] = 0xff;
        updateLayer(lay, c.l, c.t, c.w, c.h);
        return TJS_S_OK;
      },
    ],
    [
      'copyAlphaToProvince',
      (_result, args, lay) => {
        let threshold = -1;
        if (args.length > 0 && args[0]!.type !== 0) threshold = ncbInt(args[0]!);
        const c = clipSize(lay);
        if (!c) return ex.TVPThrowExceptionMessage('src must be Layer.');
        const src = prop(lay, 'mainImageBuffer');
        if (!src) return ex.TVPThrowExceptionMessage('src has no image.');
        const dst = prop(lay, 'provinceImageBufferForWrite');
        if (!dst) return ex.TVPThrowExceptionMessage('dst has no province image.');
        const dpitch = prop(lay, 'provinceImageBufferPitch');
        if (!dpitch) return ex.TVPThrowExceptionMessage('dst has no province pitch.');
        const u8 = memory();
        let s = (src >>> 0) + c.pitch * c.t + c.l * 4 + 3;
        let d = (dst >>> 0) + dpitch * c.t + c.l;
        const th = threshold & 0xff;
        const mode = threshold >= 0 && threshold < 256 ? 1 : threshold >= 256 ? 2 : 0;
        for (let y = 0; y < c.h; y++, s += c.pitch, d += dpitch)
          for (let x = 0; x < c.w; x++) {
            const a = u8[s + x * 4]!;
            u8[d + x] = mode === 0 ? a : mode === 1 ? (a >= th ? 1 : 0) : 0;
          }
        updateLayer(lay, c.l, c.t, c.w, c.h);
        return TJS_S_OK;
      },
    ],
    [
      'clipAlphaRect',
      (_result, args, dstLayer) => {
        if (args.length < 7) return TJS_E_BADPARAMCOUNT;
        let dx = ncbInt(args[0]!);
        let dy = ncbInt(args[1]!);
        const src = asObject(args[2]!);
        let sx = ncbInt(args[3]!);
        let sy = ncbInt(args[4]!);
        let w = ncbInt(args[5]!);
        let h = ncbInt(args[6]!);
        let clr = false;
        let clrval = 0;
        if (args.length >= 8 && args[7]!.type !== 0) {
          const n = ncbInt(args[7]!);
          clr = n >= 0 && n < 256;
          clrval = n & 255;
        }
        if (w <= 0 || h <= 0) return TJS_E_INVALIDPARAM;
        const dc = clipSize(dstLayer);
        if (!dc) return ex.TVPThrowExceptionMessage('dest must be Layer.');
        const sc = layerSize(src);
        if (!sc || !src) return ex.TVPThrowExceptionMessage('src must be Layer.');
        const sbufRaw = prop(src, 'mainImageBuffer');
        if (sbufRaw === null) return 0; // `return false` from a tjs_error function
        const dbufRaw = prop(dstLayer, 'mainImageBufferForWrite');
        if (dbufRaw === null) return 0;
        if (!sbufRaw || !dbufRaw) return ex.TVPThrowExceptionMessage('Layer has no images.');
        const sbuf = sbufRaw >>> 0;
        const dbuf = (dbufRaw >>> 0) + dc.pitch * dc.t + dc.l * 4;
        const {w: diw, h: dih, pitch: dpitch} = dc;
        const {w: siw, h: sih, pitch: spitch} = sc;
        const u8 = memory();
        dx -= dc.l;
        dy -= dc.t;
        const none = () => {
          if (clr) {
            for (let y = 0; y < dih; y++)
              for (let x = 0, p = dbuf + y * dpitch + 3; x < diw; x++, p += 4) u8[p] = clrval;
            updateLayer(dstLayer, dc.l, dc.t, diw, dih);
          }
          return TJS_S_OK;
        };
        if (sx + w <= 0 || sy + h <= 0 || sx >= siw || sy >= sih) return none();
        if (sx < 0) {
          w += sx;
          dx -= sx;
          sx = 0;
        }
        if (sy < 0) {
          h += sy;
          dy -= sy;
          sy = 0;
        }
        let cut: number;
        if ((cut = sx + w - siw) > 0) w -= cut;
        if ((cut = sy + h - sih) > 0) h -= cut;
        if (dx + w <= 0 || dy + h <= 0 || dx >= diw || dy >= dih) return none();
        if (dx < 0) {
          w += dx;
          sx -= dx;
          dx = 0;
        }
        if (dy < 0) {
          h += dy;
          sy -= dy;
          dy = 0;
        }
        if ((cut = dx + w - diw) > 0) w -= cut;
        if ((cut = dy + h - dih) > 0) h -= cut;
        if (w <= 0 || h <= 0) return none();
        if (clr) {
          for (let y = 0; y < dy; y++)
            for (let x = 0, p = dbuf + y * dpitch + 3; x < diw; x++, p += 4) u8[p] = clrval;
          for (let y = dy + h; y < dih; y++)
            for (let x = 0, p = dbuf + y * dpitch + 3; x < diw; x++, p += 4) u8[p] = clrval;
        }
        for (let y = 0; y < h; y++) {
          if (clr)
            for (let x = 0, p = dbuf + (y + dy) * dpitch + 3; x < dx; x++, p += 4) u8[p] = clrval;
          let p = dbuf + (y + dy) * dpitch + 3 + dx * 4;
          let q = sbuf + (y + sy) * spitch + 3 + sx * 4;
          for (let x = 0; x < w; x++, p += 4, q += 4) {
            const n = u8[p]! * u8[q]!;
            u8[p] = ((n + (n >>> 7)) >>> 8) & 0xff;
          }
          if (clr) for (let x = dx + w; x < diw; x++, p += 4) u8[p] = clrval;
        }
        if (clr) updateLayer(dstLayer, dc.l, dc.t, diw, dih);
        else updateLayer(dstLayer, dc.l + dx, dc.t + dy, w, h);
        return TJS_S_OK;
      },
    ],
    [
      'fillByProvince',
      (_result, args, lay) => {
        if (args.length < 2) return TJS_E_BADPARAMCOUNT;
        const index = ncbInt(args[0]!) & 0xff;
        const color = ncbInt(args[1]!) >>> 0;
        const c = clipSize(lay);
        const base = c ? writeBuffer(lay) : null;
        if (!c || base === null) return ex.TVPThrowExceptionMessage('must be Layer.');
        const sbuf = prop(lay, 'provinceImageBuffer');
        if (!sbuf) return ex.TVPThrowExceptionMessage('no province image.');
        const spitch = prop(lay, 'provinceImageBufferPitch');
        if (!spitch) return ex.TVPThrowExceptionMessage('no province pitch.');
        const u8 = memory();
        let s = (sbuf >>> 0) + c.t * spitch + c.l;
        let d = base + c.pitch * c.t + c.l * 4;
        for (let y = 0; y < c.h; y++, s += spitch, d += c.pitch)
          for (let x = 0; x < c.w; x++)
            if (u8[s + x] === index) {
              const p = d + x * 4;
              u8[p] = color & 0xff;
              u8[p + 1] = (color >>> 8) & 0xff;
              u8[p + 2] = (color >>> 16) & 0xff;
              u8[p + 3] = color >>> 24;
            }
        updateLayer(lay, c.l, c.t, c.w, c.h);
        return TJS_S_OK;
      },
    ],
  ];
}
