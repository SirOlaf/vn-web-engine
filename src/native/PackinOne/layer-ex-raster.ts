/**
 * PackinOne's `layerExRaster` (wamsoft layerExRaster as of 2013-06-30): `Layer.copyRaster`
 * copies a same-sized layer line by line, shifting each line horizontally by a sine wave, inside
 * the clip rectangle, then updates the clip rectangle.
 */
import {
  ncbInt,
  ncbInt64,
  NcbClassInfo,
  type NcbAttachDefinition,
} from '../../engines/kirikiri/tp-stub/ncbind.js';
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asInteger, asObject} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import type {Dispatch, TvpFunctionExporter} from '../tvp-plugin/contract.js';
import {LayerExBase} from './layer-access.js';

class LayerExRaster extends LayerExBase {}

function layerInt(layer: Dispatch, name: string): number {
  const v = new VariantSlot();
  layer.propGet(0, name, v, layer);
  const n = v.value.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(v.value)));
  v.clear();
  return n;
}

export const LAYER_EX_RASTER = new NcbClassInfo<LayerExRaster>('layerExRaster');

export function layerExRaster(
  ex: TvpFunctionExporter,
  memory: () => Uint8Array,
): NcbAttachDefinition<LayerExRaster> {
  return {
    info: LAYER_EX_RASTER,
    tjs2Class: 'Layer',
    getInstance: (info, objthis) => {
      let inst = info.instance(objthis);
      if (!inst) {
        inst = new LayerExRaster(ex, objthis);
        info.attachInstance(objthis, inst);
      }
      inst.reset();
      return inst;
    },
    define: (r) =>
      r.method('copyRaster', 5, (t, args) => {
        const src = asObject(args[0]!);
        if (!src) return;
        const width = layerInt(src, 'imageWidth');
        const height = layerInt(src, 'imageHeight');
        let buffer = layerInt(src, 'mainImageBuffer') >>> 0;
        const pitch = layerInt(src, 'mainImageBufferPitch');
        if (t.width !== width || t.height !== height) return;
        const maxh = ncbInt(args[1]!);
        const lines = ncbInt(args[2]!);
        const cycle = ncbInt(args[3]!);
        const time = Number(ncbInt64(args[4]!));
        const omega = (2 * Math.PI) / lines;
        const curH = maxh;
        let rad = ((-omega * time) / cycle) * Math.trunc(height / 2);
        rad += omega * t.clipTop;
        const dbuf = t.buffer + t.pitch * t.clipTop + t.clipLeft * 4;
        buffer += pitch * t.clipTop + t.clipLeft * 4;
        const u8 = memory();
        for (let n = 0; n < t.clipHeight; n++, rad += omega) {
          const d = Math.trunc(Math.sin(rad) * curH);
          if (d >= 0) {
            const w = t.clipWidth - d;
            const s = buffer + n * pitch;
            const o = dbuf + n * t.pitch + d * 4;
            if (w > 0) u8.copyWithin(o, s, s + w * 4);
          } else {
            const w = t.clipWidth + d;
            const s = buffer + n * pitch - d * 4;
            const o = dbuf + n * t.pitch;
            if (w > 0) u8.copyWithin(o, s, s + w * 4);
          }
        }
        t.redraw();
      }),
  };
}
