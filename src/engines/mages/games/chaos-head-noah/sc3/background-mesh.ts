import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {
  f,
  add,
  sub,
  mul,
  div,
  trunc,
  nativeSine,
  backgroundMatrix,
  clipMatrix,
} from './render-math.js';

/** 140018110: 161 by 91 positions, repeated additions (not index multiplication). */
export function backgroundWave(s: NoahState, phase: number): Float32Array {
  const left = new Float32Array(161),
    right = new Float32Array(161).fill(1920),
    top = new Float32Array(161),
    bottom = new Float32Array(161).fill(1080);
  for (let i = 0; i < s.get(0x545654); i++) {
    const a = 0x54d270 + i * 20,
      mask = s.get(a),
      amp = s.get(a + 4);
    let angle = (s.get(a + 12) + phase) | 0;
    for (let j = 0; j <= 160; j++) {
      angle = (angle + s.get(a + 16)) | 0;
      const n = Math.imul(amp, nativeSine(angle)),
        lo = mul(f((n - Math.imul(amp, 65536)) | 0), 1 / 65536),
        hi = mul(f((n + Math.imul(amp, 65536)) | 0), 1 / 65536);
      if (j <= 90) {
        if (mask & 1) left[j] = add(left[j]!, lo);
        if (mask & 2) right[j] = add(right[j]!, hi);
      }
      if (mask & 4) top[j] = add(top[j]!, lo);
      if (mask & 8) bottom[j] = add(bottom[j]!, hi);
    }
  }
  const positions = new Float32Array(161 * 91 * 2);
  for (let y = 0; y <= 90; y++) {
    let x = left[y]!;
    const step = div(sub(right[y]!, x), 160);
    for (let j = 0; j <= 160; j++) {
      positions[(y * 161 + j) * 2] = x;
      x = add(x, step);
    }
  }
  for (let x = 0; x <= 160; x++) {
    let y = top[x]!;
    const step = div(sub(bottom[x]!, y), 90);
    for (let j = 0; j <= 90; j++) {
      positions[(j * 161 + x) * 2 + 1] = y;
      y = add(y, step);
    }
  }
  return positions;
}
/** Original 140023bb0 grid and 140023950 submission. */
export function drawBackgroundMesh(
  s: NoahState,
  mode: number,
  positions?: Float32Array,
): TriangleDraw {
  const g = (o: number) => s.get(0x545500 + o),
    texture = g(0x2c),
    a = 0x1d1b200 + texture * 0x1b0,
    u = (o: number) => s.view(a + o, 2).getUint16(0, true),
    w = trunc(div(mul(u(0x72), u(0x76)), u(0x68))),
    h = trunc(div(mul(u(0x74), u(0x78)), u(0x6a)));
  const wave = mode === 14 || mode === 28,
    nx = wave ? 160 : trunc((w + 29) / 30),
    ny = wave ? 90 : trunc((h + 29) / 30),
    stepX = wave ? trunc((w + 159) / 160) : 30,
    stepY = wave ? trunc((h + 89) / 90) : 30;
  const vertices = new Float32Array((nx + 1) * (ny + 1) * 9),
    color = wave ? g(0x68) : 0xffffff,
    opacity = wave ? Math.imul(g(0x60), g(0x38)) >>> 8 : mode === 20 ? g(0x38) : 255,
    alpha = div(Math.max(0, Math.min(255, opacity)), 255);
  const ox = wave ? 0 : trunc(mul(f(-g(0x10) | 0), 1.5)),
    oy = wave ? 0 : trunc(mul(f(-g(0x14) | 0), 1.5));

  for (let y = 0; y <= ny; y++)
    for (let x = 0; x <= nx; x++) {
      const i = y * (nx + 1) + x;
      vertices.set(
        [
          positions ? positions[i * 2]! : add(f(ox), f(x * stepX)),
          positions ? positions[i * 2 + 1]! : add(f(oy), f(y * stepY)),
          0,
          div((color >>> 16) & 255, 255),
          div((color >>> 8) & 255, 255),
          div(color & 255, 255),
          alpha,
          div(f(x * stepX), f(w)),
          div(f(y * stepY), f(h)),
        ],
        i * 9,
      );
    }
  const expanded = new Float32Array(nx * ny * 54);
  let k = 0;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const i = y * (nx + 1) + x;
      for (const j of [i, i + 1, i + nx + 1, i + nx + 1, i + 1, i + nx + 2]) {
        expanded.set(vertices.subarray((j & 65535) * 9, (j & 65535) * 9 + 9), k);
        k += 9;
      }
    }
  const matrix = wave
    ? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    : backgroundMatrix(
        trunc(mul(f(g(0)), 1.5)),
        trunc(mul(f(g(4)), 1.5)),
        g(0x28),
        g(0x48),
        g(0x4c),
        g(0x50),
      );
  return {
    kind: 'triangles',
    texture,
    vertices: expanded,
    normalizedUV: true,
    transform: clipMatrix(matrix),
  };
}
