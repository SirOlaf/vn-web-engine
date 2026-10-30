/**
 * PackinOne's `shrinkCopy` (wamsoft shrinkCopy): `Layer.shrinkCopy` (area
 * averaging reduction of a source rectangle to a real-valued destination rectangle) and
 * `Layer.shrinkCopyFast` (integer step reduction that resizes the destination, alpha 255).
 * Neither updates the layer, as natively.
 *
 * The weights and sums are `unsigned long` (32 bits) and wrap as natively; edge pixels outside
 * the source rectangle are read with weight 0 or the edge weight, as the native code reads them.
 */
import {VariantSlot} from '../../engines/kirikiri/tjs2/runtime/slot.js';
import {asInteger, asObject, asReal, int} from '../../engines/kirikiri/tjs2/runtime/variant.js';
import {
  failed,
  TJS_E_BADPARAMCOUNT,
  TJS_E_FAIL,
  TJS_E_INVALIDPARAM,
  TJS_S_OK,
  type Dispatch,
} from '../tvp-plugin/contract.js';
import type {RawFunction} from './system-ex.js';

interface LayerImage {
  w: number;
  h: number;
  pitch: number;
  ptr: number;
}

function prop(lay: Dispatch, name: string): number | null {
  const v = new VariantSlot();
  if (failed(lay.propGet(0, name, v, lay))) {
    v.clear();
    return null;
  }
  const n = v.value.type === 0 ? 0 : Number(BigInt.asIntN(32, asInteger(v.value)));
  v.clear();
  return n;
}

function isValidLayer(lay: Dispatch | null): lay is Dispatch {
  if (!lay || failed(lay.isInstanceOf(0, null, 'Layer', lay))) return false;
  const has = prop(lay, 'hasImage');
  return has !== null && has !== 0;
}

/** `GetLayerBufferAndSize` (read or write buffer). */
function layerImage(lay: Dispatch | null, write: boolean): LayerImage | null {
  if (!isValidLayer(lay)) return null;
  const w = prop(lay, 'imageWidth');
  const h = prop(lay, 'imageHeight');
  const pitch = prop(lay, 'mainImageBufferPitch');
  if (w === null || h === null || pitch === null || !(w > 0 && h > 0 && pitch !== 0)) return null;
  const ptr = prop(lay, write ? 'mainImageBufferForWrite' : 'mainImageBuffer');
  return ptr ? {w, h, pitch, ptr: ptr >>> 0} : null;
}

/** `RtoL`: truncation toward zero. */
const rtol = (r: number) => (r < 0 ? -Math.trunc(-r) : Math.trunc(r));
const u32 = (x: number) => x >>> 0;
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;

interface AvgInfo {
  offset: number;
  step: number;
  ta: number;
  tc: number;
  ba: number;
  bc: number;
  total: number;
}

class ShrinkCopy {
  dtx = 0;
  dty = 0;
  dtw = 0;
  dth = 0;
  dsx = 0;
  dsy = 0;
  dex = 0;
  dey = 0;
  s!: LayerImage;
  d!: LayerImage;

  constructor(
    readonly dst: Dispatch,
    public dx: number,
    public dy: number,
    public dw: number,
    public dh: number,
    readonly src: Dispatch | null,
    public sx: number,
    public sy: number,
    public sw: number,
    public sh: number,
  ) {}

  check(): boolean {
    if (
      this.sw <= 0 ||
      this.sh <= 0 ||
      this.dw <= 0 ||
      this.dh <= 0 ||
      this.sw < rtol(this.dw) ||
      this.sh < rtol(this.dh)
    )
      return false;
    const s = layerImage(this.src, false);
    const d = layerImage(this.dst, true);
    if (!s || !d) return false;
    this.s = s;
    this.d = d;
    return true;
  }

  clip(): boolean {
    const zx = this.dw / this.sw;
    const zy = this.dh / this.sh;
    const {w: siw, h: sih} = this.s;
    if (this.sx + this.sw <= 0 || this.sy + this.sh <= 0 || this.sx >= siw || this.sy >= sih)
      return false;
    if (this.sx < 0) {
      this.sw += this.sx;
      const cut = zx * -this.sx;
      this.dw -= cut;
      this.sx = 0;
      this.dx += cut;
    }
    if (this.sy < 0) {
      this.sh += this.sy;
      const cut = zy * -this.sy;
      this.dh -= cut;
      this.sy = 0;
      this.dy += cut;
    }
    let scut: number;
    if ((scut = this.sx + this.sw - siw) > 0) {
      this.sw -= scut;
      this.dw -= zx * scut;
    }
    if ((scut = this.sy + this.sh - sih) > 0) {
      this.sh -= scut;
      this.dh -= zy * scut;
    }
    this.dtx = rtol(this.dx);
    this.dty = rtol(this.dy);
    this.dtw = rtol(this.dx + this.dw) - this.dtx;
    this.dth = rtol(this.dy + this.dh) - this.dty;
    if (this.dx + this.dw > this.dtx + this.dtw) this.dtw++;
    if (this.dy + this.dh > this.dty + this.dth) this.dth++;
    const {w: diw, h: dih} = this.d;
    if (this.dtx + this.dtw <= 0 || this.dty + this.dth <= 0 || this.dtx >= diw || this.dty >= dih)
      return false;
    this.dsx = this.dtx < 0 ? -this.dtx : 0;
    this.dsy = this.dty < 0 ? -this.dty : 0;
    this.dex = this.dtx + this.dtw > diw ? diw - this.dtx : this.dtw;
    this.dey = this.dty + this.dth > dih ? dih - this.dty : this.dth;
    return true;
  }

  /** `makeAvgTable`: fills `tbl`, returns the weight unit. */
  makeAvgTable(tbl: AvgInfo[], horz: boolean): number {
    let pos = horz ? this.dsx : this.dsy;
    const end = (horz ? this.dex : this.dey) - 1;
    const max = horz ? this.sw : this.sh;
    const ratio = max / (horz ? this.dw : this.dh);
    const diff = horz ? this.dx - this.dtx : this.dy - this.dty;
    const stop = horz ? this.sx : this.sy;
    const ofmul = horz ? 4 : this.s.pitch;
    let unit = 256;
    if (ratio <= 1.0 / 16) {
      unit = u32(Math.trunc(unit / Math.trunc(2.0 / 16.0 / ratio)));
      if (unit <= 0) unit = 1;
    }
    const wk = {unit, max, ratio, diff, stop, ofmul};
    let i = 0;
    if (pos === end) tbl[i] = this.edge(wk, pos);
    else {
      tbl[i++] = this.edge(wk, pos++);
      while (pos < end) tbl[i++] = this.inner(wk, pos++);
      tbl[i++] = this.edge(wk, pos++);
    }
    return unit;
  }

  inner(
    wk: {unit: number; ratio: number; diff: number; stop: number; ofmul: number},
    pos: number,
  ): AvgInfo {
    const unit = wk.unit;
    const r1 = (pos - wk.diff) * wk.ratio;
    const r2 = wk.ratio + r1;
    const t1 = rtol(r1);
    const t2 = rtol(r2);
    const ta = u32(unit - rtol((r1 - t1) * unit));
    const ba = u32(rtol((r2 - t2) * unit));
    const step = t2 - t1 - 1;
    return {
      offset: (wk.stop + t1 + 1) * wk.ofmul,
      step,
      ta,
      tc: ta,
      ba,
      bc: ba,
      total: u32(ta + ba + mul(step, unit)),
    };
  }

  edge(
    wk: {unit: number; max: number; ratio: number; diff: number; stop: number; ofmul: number},
    pos: number,
  ): AvgInfo {
    const unit = wk.unit;
    const r1 = (pos - wk.diff) * wk.ratio;
    const r2 = wk.ratio + r1;
    const f1 = r1 < 0 ? 0 : r1;
    const f2 = r2 > wk.max ? wk.max : r2;
    const t1 = rtol(r1);
    const t2 = rtol(r2);
    const u1 = rtol(f1);
    const u2 = rtol(f2);
    const tc = u32(unit - rtol((r1 - t1) * unit));
    const bc = u32(rtol((r2 - t2) * unit));
    return {
      offset: (wk.stop + u1 + 1) * wk.ofmul,
      total: u32(tc + bc + mul(t2 - t1 - 1, unit)),
      tc,
      bc,
      ta: u32(unit - rtol((f1 - u1) * unit)),
      ba: u32(rtol((f2 - u2) * unit)),
      step: u2 - u1 - 1,
    };
  }

  copy(u8: Uint8Array): void {
    const horz: AvgInfo[] = [];
    const vert: AvgInfo[] = [];
    const hu = this.makeAvgTable(horz, true);
    const vu = this.makeAvgTable(vert, false);
    const unit = mul(hu, vu);
    const spch = this.s.pitch;
    const dpch = this.d.pitch;
    const read = (a: number) => u8[a] ?? 0;
    const sum = [0, 0, 0, 0];
    const add = (p: number, m1: number, m2: number) => {
      sum[0] = u32(sum[0]! + mul(read(p), m2));
      sum[1] = u32(sum[1]! + mul(read(p + 1), m2));
      sum[2] = u32(sum[2]! + mul(read(p + 2), m2));
      sum[3] = u32(sum[3]! + mul(read(p + 3), m1));
    };
    const point = (p: number, m1: number, m2: number) => {
      if (m1) add(p, m1, m2);
    };
    const horzLine = (p: number, w: number, m1: number, m2: number) => {
      if (m1) for (; w > 0; w--, p += 4) add(p, m1, m2);
    };
    const vertLine = (p: number, h: number, m1: number, m2: number) => {
      if (m1) for (; h > 0; h--, p += spch) add(p, m1, m2);
    };
    const rect = (p: number, w: number, h: number, m: number) => {
      if (m) for (; h > 0; h--, p += spch) for (let n = 0, r = p; n < w; n++, r += 4) add(r, m, m);
    };
    let pl = this.d.ptr + ((this.dtx + this.dsx) << 2) + (this.dty + this.dsy) * dpch;
    for (let y = this.dsy, vi = 0; y < this.dey; y++, vi++, pl += dpch) {
      const v = vert[vi]!;
      const rl = this.s.ptr + v.offset;
      for (let x = this.dsx, hi = 0, p = pl; x < this.dex; x++, hi++, p += 4) {
        const h = horz[hi]!;
        sum.fill(0);
        const r = rl + h.offset;
        const w = h.step;
        const vh = v.step;
        const ox = w << 2;
        const oy = vh * spch;
        point(r - 4 - spch, mul(h.ta, v.ta), mul(h.tc, v.tc));
        horzLine(r - spch, w, mul(hu, v.ta), mul(hu, v.tc));
        point(r + ox - spch, mul(h.ba, v.ta), mul(h.bc, v.tc));
        vertLine(r - 4, vh, mul(h.ta, vu), mul(h.tc, vu));
        rect(r, w, vh, unit);
        vertLine(r + ox, vh, mul(h.ba, vu), mul(h.bc, vu));
        point(r - 4 + oy, mul(h.ta, v.ba), mul(h.tc, v.bc));
        horzLine(r + oy, w, mul(hu, v.ba), mul(hu, v.bc));
        point(r + ox + oy, mul(h.ba, v.ba), mul(h.bc, v.bc));
        const div = mul(h.total, v.total);
        for (let c = 0; c < 4; c++) u8[p + c] = Math.trunc(sum[c]! / div) & 0xff;
      }
    }
  }
}

/** `LimitedShrink`. */
function shrinkFast(
  u8: Uint8Array,
  dst: Dispatch,
  s: LayerImage,
  stepx: number,
  stepy: number,
): number {
  const nw = Math.trunc((s.w + stepx - 1) / stepx);
  const nh = Math.trunc((s.h + stepy - 1) / stepy);
  if (failed(dst.funcCall(0, 'setImageSize', null, [int(nw), int(nh)], dst))) return TJS_E_FAIL;
  const d = layerImage(dst, true);
  if (!d) return TJS_E_FAIL;
  const xdiv = Math.trunc(s.w / stepx);
  const xrem = s.w - xdiv * stepx;
  /** One source line reduced horizontally into `out` at `at`. */
  const lineX = (out: Uint8Array, at: number, src: number) => {
    let o = at;
    let r = src;
    const take = (len: number, shrink: number, step: number) => {
      for (; len > 0; len--, r += step) {
        if (shrink === 1) {
          out[o++] = u8[r]!;
          out[o++] = u8[r + 1]!;
          out[o++] = u8[r + 2]!;
          out[o++] = 255;
          continue;
        }
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let sub = shrink, t = r; sub > 0; sub--, t += 4) {
          sr += u8[t]!;
          sg += u8[t + 1]!;
          sb += u8[t + 2]!;
        }
        out[o++] = Math.trunc(sr / shrink) & 0xff;
        out[o++] = Math.trunc(sg / shrink) & 0xff;
        out[o++] = Math.trunc(sb / shrink) & 0xff;
        out[o++] = 255;
      }
    };
    take(xdiv, stepx, stepx * 4);
    if (xrem > 0) take(1, xrem, 0);
  };
  /** `shrinkLineY`: `shrink` buffered lines averaged into the destination line. */
  const lineY = (dstLine: number, buf: Uint8Array, bpch: number, shrink: number) => {
    let o = dstLine;
    for (let x = 0; x < d.w; x++) {
      const r = x * 4;
      if (shrink === 1) {
        u8[o++] = buf[r]!;
        u8[o++] = buf[r + 1]!;
        u8[o++] = buf[r + 2]!;
        u8[o++] = 255;
        continue;
      }
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sub = shrink, t = r; sub > 0; sub--, t += bpch) {
        sr += buf[t]!;
        sg += buf[t + 1]!;
        sb += buf[t + 2]!;
      }
      u8[o++] = Math.trunc(sr / shrink) & 0xff;
      u8[o++] = Math.trunc(sg / shrink) & 0xff;
      u8[o++] = Math.trunc(sb / shrink) & 0xff;
      u8[o++] = 255;
    }
  };
  let pd = d.ptr;
  let ps = s.ptr;
  if (stepy <= 1) {
    for (let y = 0; y < s.h; y++, pd += d.pitch, ps += s.pitch) lineX(u8, pd, ps);
  } else {
    const bpch = d.w * 4;
    const buf = new Uint8Array(bpch * stepy);
    const div = Math.trunc(s.h / stepy);
    for (let len = div; len > 0; len--, pd += d.pitch) {
      for (let sub = stepy, ofs = 0; sub > 0; sub--, ofs += bpch, ps += s.pitch)
        lineX(buf, ofs, ps);
      lineY(pd, buf, bpch, stepy);
    }
    if (div * stepy < s.h) {
      const yrem = s.h - div * stepy;
      for (let sub = yrem, ofs = 0; sub > 0; sub--, ofs += bpch, ps += s.pitch) lineX(buf, ofs, ps);
      lineY(pd, buf, bpch, yrem);
    }
  }
  return TJS_S_OK;
}

export function shrinkCopyFunctions(memory: () => Uint8Array): [string, RawFunction][] {
  return [
    [
      'shrinkCopy',
      (_result, args, dst) => {
        if (args.length < 9) return TJS_E_BADPARAMCOUNT;
        const n = (i: number) => Number(BigInt.asIntN(32, asInteger(args[i]!)));
        const inst = new ShrinkCopy(
          dst,
          asReal(args[0]!),
          asReal(args[1]!),
          asReal(args[2]!),
          asReal(args[3]!),
          asObject(args[4]!),
          n(5),
          n(6),
          n(7),
          n(8),
        );
        if (!inst.check()) return TJS_E_INVALIDPARAM;
        if (!inst.clip()) return TJS_S_OK;
        inst.copy(memory());
        return TJS_S_OK;
      },
    ],
    [
      'shrinkCopyFast',
      (_result, args, dst) => {
        if (args.length < 2) return TJS_E_BADPARAMCOUNT;
        const stepx = Number(BigInt.asIntN(32, asInteger(args[1]!)));
        let stepy = args.length >= 3 ? Number(BigInt.asIntN(32, asInteger(args[2]!))) : 0;
        if (!stepy) stepy = stepx;
        const s = stepx > 0 && stepy > 0 ? layerImage(asObject(args[0]!), false) : null;
        if (!s || !isValidLayer(dst)) return TJS_E_INVALIDPARAM;
        return shrinkFast(memory(), dst, s, stepx, stepy);
      },
    ],
  ];
}
