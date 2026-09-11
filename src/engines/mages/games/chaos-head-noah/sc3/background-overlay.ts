import {nativeBlend, nativeSampler} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {SpriteDraw} from '../../../../../graphics/draw-list.js';
import {f, add, sub, mul, div, trunc} from './render-math.js';
/** 1400165a0 / 140016d80: two independently positioned, clipped strip overlays. */
export function drawBackgroundOverlay(s: NoahState, bank: number): SpriteDraw[] {
  const base = 0x5aa0 + bank * 80,
    v = (off: number) => s.variable((base + off) / 4),
    mode = s.variableBytes[base + 2]!,
    alpha = v(36);
  if (!mode || !alpha) return [];
  const first = s.variableBytes[base + 1]!,
    second = s.variableBytes[base]!,
    texture = s.variable(0xd48 + first),
    a = 0x1d1b200 + texture * 0x1b0,
    u = (off: number) => s.view(a + off, 2).getUint16(0, true),
    tw = trunc(div(mul(u(0x72), u(0x76)), u(0x68))),
    th = trunc(div(mul(u(0x74), u(0x78)), u(0x6a))),
    q = (off: number) => trunc(mul(f(v(off) >>> 0), 1.5));
  const x = q(4),
    y = q(8),
    w = q(12),
    h = q(16),
    dx = q(20),
    dy = q(24),
    dw = q(28),
    dh = q(32),
    right = (x + w) | 0,
    bottom = (y + h) | 0,
    dr = (dx + dw) | 0,
    db = (dy + dh) | 0,
    out: SpriteDraw[] = [];
  const ratio = (a: number, b: number, c: number) => Math.trunc(Math.imul(a, b) / c);
  const clip = (left: number, top: number, r: number, b: number) => {
    if (!(
      x < r &&
      y < b &&
      w > 0 &&
      h > 0 &&
      right > left &&
      bottom > top &&
      dx < tw &&
      dy < th &&
      dw > 0 &&
      dh > 0 &&
      dr > 0 &&
      db > 0
    ))
      return;
    let sx = x,
      sy = y,
      ex = right,
      ey = bottom,
      tx = dx,
      ty = dy,
      tx2 = dr,
      ty2 = db;
    if (x < left) {
      sx = left;
      tx = (dx - ratio((x - left) | 0, dw, w)) | 0;
    }
    if (y < top) {
      sy = top;
      ty = (dy - ratio((y - top) | 0, dh, h)) | 0;
    }
    if (r < right) {
      ex = r;
      tx2 = (dr - ratio((right - r) | 0, dw, w)) | 0;
    }
    if (b < bottom) {
      ey = b;
      ty2 = (db - ratio((bottom - b) | 0, dh, h)) | 0;
    }
    return {
      sx,
      sy,
      sw: (ex - sx) | 0,
      sh: (ey - sy) | 0,
      tx,
      ty,
      dw: (tx2 - tx) | 0,
      dh: (ty2 - ty) | 0,
    };
  };
  const emit = (slot: number, p: NonNullable<ReturnType<typeof clip>>, ox = 0, oy = 0) => {
    if (p.sw < 1 || p.sh < 1 || p.dw < 1 || p.dh < 1) return;
    const x = f(p.tx),
      y = f(p.ty);
    out.push({
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
      texture: s.variable(0xd48 + slot),
      source: {
        x: f((p.sx - ox) >>> 0),
        y: f((p.sy - oy) >>> 0),
        width: f(p.sw >>> 0),
        height: f(p.sh >>> 0),
      },
      destination: {
        x,
        y,
        width: p.sw === p.dw && p.sh === p.dh ? f(p.sw >>> 0) : sub(add(f(p.dw), x), x),
        height: p.sw === p.dw && p.sh === p.dh ? f(p.sh >>> 0) : sub(add(f(p.dh), y), y),
      },
      color: 0xffffff,
      alpha: Math.max(0, Math.min(255, alpha)),
    });
  };
  const primary = clip(0, 0, tw, th);
  if (mode === 1) {
    if (primary) emit(first, primary);
  } else if (mode === 2) {
    if (primary) emit(first, primary);
    const p = clip(tw, 0, Math.imul(tw, 2), th);
    if (p) emit(second, p, tw, 0);
  } else if (mode === 3) {
    if (primary) emit(first, primary);
    const p = clip(0, th, tw, Math.imul(th, 2));
    if (p) emit(second, p, 0, th);
  }
  return out;
}
