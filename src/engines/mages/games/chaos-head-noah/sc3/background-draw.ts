import {nativeSampler, nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {DrawCommand, SpriteDraw} from '../../../../../graphics/draw-list.js';
import {drawBackgroundMesh, backgroundWave} from './background-mesh.js';
import {initializeBackgroundBreakup, drawBackgroundBreakup} from './background-breakup.js';
import {backgroundShaders} from './background-shaders.js';
const f = Math.fround;
const add = (a: number, b: number) => f(a + b),
  sub = (a: number, b: number) => f(a - b),
  mul = (a: number, b: number) => f(a * b),
  div = (a: number, b: number) => f(a / b);
const trunc = (v: number) =>
  !Number.isFinite(v) || v >= 2147483648 || v < -2147483648 ? -2147483648 : Math.trunc(v);

/** Native background geometry 140013150. All six positioning modes and strip joins. */
export function backgroundGeometry(s: NoahState): void {
  const get = (o: number) => s.get(0x545500 + o),
    put = (o: number, v: number) => s.put(0x545500 + o, v),
    float = (o: number, v: number) => {
      const view = s.view(0x545500 + o, 4);
      if (Number.isNaN(v)) view.setUint32(0, 0xffc00000, true);
      else view.setFloat32(0, v, true);
    };
  const composition = get(0x40) >>> 0,
    resolve = (mask: number, offset: number) => {
      if (mask && !(mask & (mask - 1)) && mask <= 128)
        put(offset, s.variable(0x3520 / 4 + Math.log2(mask)));
    };
  if (get(0x2c) !== 200) resolve((composition >>> 8) & 255, 0x2c);
  const a = 0x1d1b200 + get(0x2c) * 0x1b0,
    u = (o: number) => s.view(a + o, 2).getUint16(0, true);
  let width = f(trunc(div(mul(u(0x72), u(0x76)), u(0x68)))),
    height = f(trunc(div(mul(u(0x74), u(0x78)), u(0x6a))));
  let x2 = 0,
    y2 = 0,
    y3 = 0,
    sx1 = 0,
    sy1 = 0,
    sx2 = 0,
    sy2 = 0,
    sy3 = 0;
  switch ((composition >>> 16) & 255) {
    case 1:
      height = sub(height, 1);
      sy1 = 1;
      y2 = -height;
      sy2 = add(height, 1);
      break;
    case 2:
      height = sub(height, 1);
      y2 = height;
      sy2 = add(-height, 1);
      break;
    case 3:
      width = sub(width, 1);
      sx1 = 1;
      x2 = -width;
      sx2 = add(width, 1);
      break;
    case 4:
      width = sub(width, 1);
      x2 = width;
      sx2 = add(-width, 1);
      break;
    case 5:
      height = sub(height, 1);
      sy1 = 1;
      y2 = -height;
      sy2 = add(height, 1);
      y3 = sub(-height, height);
      sy3 = add(height, height);
      break;
    case 6:
      height = sub(height, 1);
      y2 = height;
      sy2 = add(-height, 1);
      y3 = add(height, height);
      sy3 = add(add(-height, -height), 1);
      break;
  }
  resolve(composition & 255, 0x30);
  resolve(composition >>> 24, 0x34);
  // Native clears only width/height, preserving stale coordinates for empty strips.
  for (const base of [0x90, 0xb0, 0xd0]) {
    float(base, 0);
    float(base + 4, 0);
  }
  const rect = (
    base: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) => {
    [sx, sy, sw, sh, dx, dy, dw, dh].forEach((v, i) => float(base + i * 4, v));
  };
  const mode = get(0x44);
  let x = 0,
    y = 0,
    vw = 0,
    vh = 0;
  switch (mode) {
    case 0:
      x = mul(f(get(0)), 1.5);
      y = mul(f(get(4)), 1.5);
      vw = 1920;
      vh = 1080;
      break;
    case 4:
      x = mul(div(s.view(0x545508, 4).getFloat32(0, true), 1000), 1.5);
      y = mul(div(s.view(0x54550c, 4).getFloat32(0, true), 1000), 1.5);
      vw = 1920;
      vh = 1080;
      break;
    case 1:
      vw = mul(f(get(0x20)), 1.5);
      vh = mul(f(get(0x24)), 1.5);
      if (vw <= 0.1 || vh <= 0.1) return;
      x = mul(f(get(0x18)), 1.5);
      y = mul(f(get(0x1c)), 1.5);
      break;
    case 2: {
      const scale = f(get(0x28));
      if (scale <= 0) return;
      const w = div(mul(scale, width), 1000),
        h = div(mul(scale, height), 1000);
      let dx = sub(mul(f(get(0)), 1.5), mul(w, 0.5)),
        dy = sub(mul(f(get(4)), 1.5), mul(h, 0.5));
      let sx = 0,
        sy = 0,
        sw = width,
        sh = height,
        dw = w,
        dh = h;
      if (dx < 0) {
        sx = sub(0, div(mul(dx, width), w));
        dw = sub(w, -dx);
        sw = sub(width, div(mul(-dx, width), w));
        dx = 0;
      }
      if (add(dx, dw) > 1920) {
        const excess = sub(add(dx, dw), 1920);
        dw = sub(dw, excess);
        sw = sub(sw, div(mul(excess, width), w));
      }
      if (dy < 0) {
        sy = sub(0, div(mul(dy, height), h));
        dh = sub(h, -dy);
        sh = sub(height, div(mul(-dy, height), h));
        dy = 0;
      }
      if (add(dy, dh) > 1080) {
        const excess = sub(add(dy, dh), 1080);
        dh = sub(dh, excess);
        sh = sub(sh, div(mul(excess, height), h));
      }
      rect(0x88, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }
    case 3:
      rect(
        0x88,
        mul(f(get(0x18)), 1.5),
        mul(f(get(0x1c)), 1.5),
        mul(f(get(0x20)), 1.5),
        mul(f(get(0x24)), 1.5),
        mul(f(get(0)), 1.5),
        mul(f(get(4)), 1.5),
        mul(f(get(0x20)), 1.5),
        mul(f(get(0x24)), 1.5),
      );
      return;
    case 5:
      x = sy1;
      y = sy1;
      break;
    default:
      return;
  }
  const right = add(x, vw),
    bottom = add(y, vh);
  const strip = (base: number, left: number, top: number, offsetX: number, offsetY: number) => {
    const r = add(left, width),
      b = add(top, height);
    if (!(x < r && y < b && left < right && top < bottom)) return;
    const sx = Math.max(x, left),
      sy = Math.max(y, top),
      sw = sub(Math.min(right, r), sx),
      sh = sub(Math.min(bottom, b), sy);
    rect(
      base,
      add(sx, offsetX),
      add(sy, offsetY),
      sw,
      sh,
      x > left ? 0 : div(mul(sub(left, x), 1920), vw),
      y > top ? 0 : div(mul(sub(top, y), 1080), vh),
      div(mul(sw, 1920), vw),
      div(mul(sh, 1080), vh),
    );
  };
  strip(0x88, 0, 0, sx1, sy1);
  if (x2 !== 0 || y2 !== 0) strip(0xa8, x2, y2, sx2, sy2);
  if (y3 !== 0) strip(0xc8, 0, y3, 0, sy3);
}

/** 140012d90 and the verified 40-entry table at 1401d6e40. */
export function drawBackground(s: NoahState, index: number): DrawCommand[] {
  const variable = (offset: number) => s.variable(offset),
    b = 0x1194 + index * 40,
    o = 0x960 + index * 10,
    p = (offset: number, v: number) => s.put(0x545500 + offset, v),
    v = (j: number) => variable(b + j),
    sum = (j: number, k: number) => (v(j) + variable(o + k)) | 0;
  p(0, sum(0, 0));
  p(4, sum(1, 1));
  s.view(0x545508, 4).setFloat32(0, s.get(0x545500), true);
  s.view(0x54550c, 4).setFloat32(0, s.get(0x545504), true);
  p(0x10, sum(2, 2));
  p(0x14, sum(3, 2));
  p(0x18, s.get(0x545510));
  p(0x1c, sum(3, 3));
  p(0x20, sum(5, 5));
  p(0x24, sum(6, 6));
  p(0x28, sum(4, 4));
  p(0x44, v(9));
  p(0x50, sum(12, 7));
  p(0x5c, v(14));
  p(0x60, sum(13, 8));
  p(0x64, v(15));
  p(0x68, v(19));
  p(0x6c, s.flag(0x992 + index));
  const mask = 1 << index,
    id =
      variable(0x62a4 / 4) === mask
        ? 200
        : variable(0x62b0 / 4) === mask
          ? 201
          : variable(0x3520 / 4 + index);
  p(0x2c, id);
  p(0x40, 0);
  const a = 0x1d1b200 + id * 0x1b0,
    u = (off: number) => s.view(a + off, 2).getUint16(0, true);
  p(0x70, trunc(div(mul(u(0x72), u(0x76)), u(0x68))));
  p(0x74, trunc(div(mul(u(0x74), u(0x78)), u(0x6a))));
  p(0x38, sum(10, 9));
  p(0x3c, v(11));
  p(0x54, v(16));
  p(0x58, v(17));
  if (!s.bytes(a + 0x30, 1)[0]) return [];
  for (let i = 0; i < 4; i++) {
    const composition = variable(0x4628 / 4 + i);
    if (((composition >>> 8) & 255) === mask && ((composition >>> 16) & 255) !== 0) {
      p(0x40, composition);
      break;
    }
  }
  return drawBackgroundMode(s);
}
/** Shared native table entered by both scene backgrounds and captured composites. */
export function drawBackgroundMode(s: NoahState): DrawCommand[] {
  const mode = s.get(0x54553c) >>> 0;
  if (mode >= 40) return []; // Native table bound.
  const progress = s.get(0x545538),
    opacity = s.get(0x545560),
    fade = [1, 13, 14, 15, 16, 17, 18, 20, 22, 25, 26, 27, 28].includes(mode);
  if (mode === 21 || (fade && progress === 0)) return [];
  if (mode === 19 || mode === 20) return [drawBackgroundMesh(s, mode)];
  backgroundGeometry(s);
  if (mode === 13 || mode === 17 || mode === 18) return [];
  if (mode === 2) {
    if (progress === -1) {
      initializeBackgroundBreakup(s);
      return [];
    }
    return [drawBackgroundBreakup(s)];
  }
  if (mode === 14 || mode === 28) {
    for (let i = 0; i < s.get(0x545654); i++) {
      const a = 0x54d27c + i * 20;
      s.put(a, s.get(a) + s.get(a - 4));
    }
    const positions = backgroundWave(s, mode === 28 ? s.get(0x54555c) : 0);
    return s.view(0x545590, 4).getFloat32(0, true) !== 0 &&
      s.view(0x545594, 4).getFloat32(0, true) !== 0
      ? [drawBackgroundMesh(s, mode, positions)]
      : [];
  }
  const result: SpriteDraw[] = [],
    alpha = Math.max(0, Math.min(255, fade ? Math.imul(opacity, progress) >>> 8 : opacity));
  for (let i = 0; i < (mode === 3 || mode === 4 ? 1 : 3); i++) {
    const id = s.get(0x54552c + i * 4),
      a = 0x545588 + i * 32,
      values = Array.from({length: 8}, (_, j) => s.view(a + j * 4, 4).getFloat32(0, true));
    const [x, y, width, height, dx, dy, dw, dh] = values as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (width === 0 || height === 0) continue;
    // Only the ordinary and fade entrypoints perform the extra surface-ready gate.
    if (
      (mode === 0 || mode === 1 || (mode >= 5 && mode <= 12) || mode >= 29) &&
      !s.bytes(0x1d1b230 + id * 0x1b0, 1)[0]
    )
      continue;
    const make = (
      left: number,
      top: number,
      right: number,
      bottom: number,
      opacity: number,
    ): SpriteDraw => ({
      texture: id,
      source: {x, y, width, height},
      destination: {x: left, y: top, width: sub(right, left), height: sub(bottom, top)},
      color: s.get(0x545568) & 0xffffff,
      alpha: opacity,
      ...nativeSampler(s),
      blendState: nativeBlend(s.get(0x587344) & 65535),
    });
    if (mode === 3 || mode === 4) {
      result.push(make(dx, dy, add(dx, dw), add(dy, dh), 255));
      for (let n = progress; n > 0; n -= 16) {
        const offset = f(mode === 3 ? -n : n);
        result.push(
          make(
            add(dx, offset),
            add(dy, offset),
            sub(add(dx, dw), offset),
            sub(add(dy, dh), offset),
            64,
          ),
        );
      }
      continue;
    }
    const draw = make(dx, dy, add(dx, dw), add(dy, dh), alpha);
    if (mode === 15 || mode === 16) {
      const texture = (s.get(0x54555c) + 100) | 0,
        ma = 0x1d1b200 + texture * 0x1b0,
        mw = s.view(ma + 0x6c, 2).getUint16(0, true),
        mh = s.view(ma + 0x6e, 2).getUint16(0, true),
        softness = s.get(0x545564) || 16,
        scale = div(256, f(softness)),
        clamped = Math.min(Math.max(0, progress), (softness + 256) | 0);
      draw.alpha = Math.max(0, Math.min(255, opacity));
      draw.mask = {
        texture,
        source: {
          x: mul(div(dx, 1920), mw),
          y: mul(div(dy, 1080), mh),
          width: mul(div(draw.destination.width, 1920), mw),
          height: mul(div(draw.destination.height, 1080), mh),
        },
        scale,
        bias: div(mul(f((255 - clamped) | 0), scale), 255),
        invert: mode === 16,
      };
    } else if (mode === 23 || mode === 24) {
      // 140023520 deliberately passes endpoints in the destination extent fields.
      draw.destination.width = add(dx, dw);
      draw.destination.height = add(dy, dh);
      draw.mask = {texture: 202, source: {...draw.destination}, channel: 'red', scale: 1, bias: 0};
    } else if (backgroundShaders[mode]) draw.fragment = backgroundShaders[mode];
    result.push(draw);
  }
  return result;
}

/** 140012a90: captured composites enter the same table without the texture-ready gate. */
export function drawCapturedBackground(s: NoahState, index: number): DrawCommand[] {
  const b = 0x1388 + index * 20,
    o = 0x94c + index * 10,
    p = (offset: number, v: number) => s.put(0x545500 + offset, v),
    v = (j: number) => s.variable(b + j),
    sum = (j: number, k: number) => (v(j) + s.variable(o + k)) | 0;
  p(0, sum(0, 0));
  p(4, sum(1, 1));
  s.view(0x545508, 4).setFloat32(0, s.get(0x545500), true);
  s.view(0x54550c, 4).setFloat32(0, s.get(0x545504), true);
  p(0x10, sum(2, 2));
  p(0x14, sum(3, 2));
  p(0x18, s.get(0x545510));
  p(0x1c, sum(3, 3));
  p(0x28, sum(4, 4));
  p(0x20, sum(5, 5));
  p(0x24, sum(6, 6));
  p(0x44, v(9));
  p(0x50, sum(12, 7));
  p(0x5c, v(14));
  p(0x60, sum(13, 8));
  p(0x64, v(15));
  p(0x68, v(17));
  p(0x40, 0);
  p(0x54, 1280);
  p(0x58, 720);
  p(0x6c, 2 + s.flag(0x99a + index));
  p(0x2c, index === 0 ? 200 : 201);
  const a = 0x1d1b200 + (index === 0 ? 200 : 201) * 0x1b0,
    u = (off: number) => s.view(a + off, 2).getUint16(0, true);
  p(0x70, trunc(div(mul(u(0x72), u(0x76)), u(0x68))));
  p(0x74, trunc(div(mul(u(0x74), u(0x78)), u(0x6a))));
  p(0x38, sum(10, 9));
  p(0x3c, v(11));
  return drawBackgroundMode(s);
}
