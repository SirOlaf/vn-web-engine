import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {f, add, sub, mul, div, trunc} from './render-math.js';
import {submitTriangles} from './triangle-submit.js';

/** 140018bb0. Position jitter and per-triangle RNG calls retain native order. */
export function initializeBackgroundBreakup(s: NoahState): void {
  const read = (o: number) => s.view(0x545500 + o, 4).getFloat32(0, true),
    sx = read(0x88),
    sy = read(0x8c),
    sw = read(0x90),
    sh = read(0x94),
    w = read(0xa0),
    h = read(0xa4),
    stepX = mul(w, 1 / 64),
    stepY = div(h, 36);
  const xs = new Float32Array(65 * 37),
    ys = new Float32Array(65 * 37),
    v = new DataView(s.backgroundFragments.buffer),
    put = (a: number, n: number) => v.setFloat32(a, n, true),
    int = (a: number, n: number) => v.setInt32(a, n, true);
  const random = (step: number, i: number) =>
    sub(
      add(
        div(f(Math.imul(Math.imul(s.random15() & 32767, trunc(add(step, 0.5))), 10) >>> 15), 10),
        mul(f(i), step),
      ),
      mul(step, 0.5),
    );
  for (let y = 0; y <= 36; y++)
    for (let x = 0; x <= 64; x++) {
      const i = y * 65 + x;
      xs[i] = x === 0 ? 0 : x === 64 ? w : random(stepX, x);
      ys[i] = y === 0 ? 0 : y === 36 ? h : random(stepY, y);
    }
  const texture = s.get(0x54552c),
    a = 0x1d1b200 + texture * 0x1b0,
    tw = s.view(a + 0x6c, 2).getUint16(0, true),
    th = s.view(a + 0x6e, 2).getUint16(0, true);
  let index = 0;
  for (let y = 0; y < 36; y++)
    for (let x = 0; x < 64; x++) {
      const i = y * 65 + x;
      for (const ids of [
        [i, i + 1, i + 65],
        [i + 1, i + 65, i + 66],
      ]) {
        const a = index++ * 0x68,
          px = ids.map((i) => xs[i]!),
          py = ids.map((i) => ys[i]!),
          cx = add(mul(sub(Math.max(...px), Math.min(...px)), 0.5), Math.min(...px)),
          cy = add(mul(sub(Math.max(...py), Math.min(...py)), 0.5), Math.min(...py));
        int(a, 256);
        put(a + 0x34, cx);
        put(a + 0x38, cy);
        for (let j = 0; j < 3; j++) {
          put(a + 4 + j * 8, div(add(div(mul(px[j]!, sw), w), sx), tw));
          put(a + 8 + j * 8, div(add(div(mul(py[j]!, sh), h), sy), th));
          put(a + 0x1c + j * 8, sub(px[j]!, cx));
          put(a + 0x20 + j * 8, sub(py[j]!, cy));
          int(a + 0x44 + j * 4, 0);
        }
        for (let j = 0; j < 3; j++) int(a + 0x50 + j * 4, ((s.random15() & 32767) >>> 5) - 512);
        for (let j = 0; j < 2; j++)
          put(a + 0x5c + j * 4, sub(div(f(((s.random15() & 32767) * 1200) >>> 15), 100), 6));
        int(a + 0x64, (((s.random15() & 32767) * 20) >>> 15) + 10);
      }
    }
  s.put(0x56ca9c, index);
}

/** 1400194e0 and 1400198a0: absolute progress, independent triangle rotations. */
export function drawBackgroundBreakup(s: NoahState): TriangleDraw {
  const v = new DataView(s.backgroundFragments.buffer),
    get = (a: number) => v.getFloat32(a, true),
    int = (a: number) => v.getInt32(a, true),
    put = (a: number, n: number) => v.setFloat32(a, n, true),
    p = s.get(0x545538),
    count = s.get(0x56ca9c) >>> 0,
    out: number[] = [];
  let active = 0;
  for (let i = 0; i < count; i++) {
    const a = i * 0x68;
    for (let j = 0; j < 3; j++)
      v.setInt32(a + 0x44 + j * 4, Math.imul(p, int(a + 0x50 + j * 4)), true);
    put(a + 0x3c, add(mul(f(p >>> 0), get(a + 0x5c)), get(a + 0x34)));
    put(a + 0x40, add(mul(f(p >>> 0), get(a + 0x60)), get(a + 0x38)));
    const delay = int(a + 0x64),
      alpha = p <= delay ? 256 : (p - delay) >>> 0 < 32 ? ((delay - p) * 8 + 256) | 0 : 0;
    v.setInt32(a, alpha, true);
    if (alpha) active = 1;
  }
  s.setFlag(0x9b0, active);
  for (let i = 0; i < count; i++) {
    const a = i * 0x68;
    if (!int(a)) continue;
    const angle = (j: number) => mul(mul(f(int(a + 0x44 + j * 4)), f(Math.PI)), 1 / 32768),
      x = angle(0),
      y = angle(1),
      z = angle(2),
      cx = f(Math.cos(x)),
      sx = f(Math.sin(x)),
      cy = f(Math.cos(y)),
      sy = f(Math.sin(y)),
      cz = f(Math.cos(z)),
      sz = f(Math.sin(z));
    const m = [
      mul(cz, cy),
      sub(mul(mul(sx, sy), cz), mul(cx, sz)),
      add(mul(mul(cx, sy), cz), mul(sx, sz)),
      0,
      mul(sz, cy),
      add(mul(cx, cz), mul(mul(sx, sy), sz)),
      sub(mul(mul(cx, sy), sz), mul(sx, cz)),
      0,
      -sy,
      mul(sx, cy),
      mul(cx, cy),
      0,
      0,
      0,
      0,
      1,
    ];
    // This matrix is also native global scratch, written even for culled triangles.
    for (let j = 0; j < 16; j++) s.view(0x1d7d1d0 + j * 4, 4).setFloat32(0, m[j]!, true);
    const px: number[] = [],
      py: number[] = [];
    for (let j = 0; j < 3; j++) {
      const vx = get(a + 0x1c + j * 8),
        vy = get(a + 0x20 + j * 8);
      px.push(add(add(add(add(mul(vx, m[0]!), mul(vy, m[1]!)), mul(m[2]!, 0)), 0), get(a + 0x3c)));
      py.push(add(add(add(add(mul(vx, m[4]!), mul(vy, m[5]!)), mul(m[6]!, 0)), 0), get(a + 0x40)));
    }
    if (
      !px.some((x) => x >= 0) ||
      !px.some((x) => x <= 1920) ||
      !py.some((y) => y >= 0) ||
      !py.some((y) => y <= 1080)
    )
      continue;
    for (let j = 0; j < 3; j++)
      out.push(
        px[j]!,
        py[j]!,
        1,
        1,
        1,
        1,
        div(Math.min(255, int(a) >>> 0), 255),
        get(a + 4 + j * 8),
        get(a + 8 + j * 8),
      );
  }
  s.triangleVertices.set(out);
  return submitTriangles(s, s.get(0x54552c), out.length / 27);
}
