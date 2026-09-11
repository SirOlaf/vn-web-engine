import {particleRotation} from './snow.js';
import {submitTriangles} from './triangle-submit.js';
import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
const f = Math.fround,
  add = (a: number, b: number) => f(a + b),
  sub = (a: number, b: number) => f(a - b),
  mul = (a: number, b: number) => f(a * b),
  div = (a: number, b: number) => f(a / b);
const trunc = (a: number) =>
  a >= 2147483648 || a < -2147483648 || !Number.isFinite(a) ? -2147483648 : Math.trunc(a);
/** 14001b280. Both banks update all 2000 particles when their count is nonzero. */
export function advanceRain(s: NoahState): void {
  const read = (a: number) => s.view(a, 4).getFloat32(0, true),
    write = (a: number, v: number) => s.view(a, 4).setFloat32(0, v, true);
  for (let bank = 0; bank < 2; bank++) {
    const v = (a: number) => s.variable(a / 4 + bank * 20),
      base = bank * 2000,
      count = v(0x5dc8) >>> 0,
      density = v(0x5ddc) >>> 0,
      speed = mul(f(v(0x5dd4) >>> 0), 1 / 65536);
    s.put(0x56cdb8 + bank * 4, count);
    write(0x586a40 + bank * 4, speed);
    if (!count) continue;
    for (let i = 0; i < 2000; i++) {
      const n = base + i,
        a = 0x57ae30 + n * 12,
        z = sub(read(a + 8), speed);
      write(a + 8, z);
      let opacity = 256;
      if (z < -1000) {
        const x = (((s.random15() & 32767) * 4000) >>> 15) - 2000,
          y = (((s.random15() & 32767) * 2000) >>> 15) - 1000;
        s.put(0x54d400 + n * 8, x);
        s.put(0x54d404 + n * 8, y);
        write(a, x);
        write(a + 4, y);
        write(a + 8, 1000);
      } else if (sub(1000, f(density)) <= z) {
        const edge = sub(1064, f(density));
        if (z < edge) opacity = 256 - trunc(mul(sub(edge, z), 4));
      } else opacity = 0;
      s.put(0x570e60 + n * 4, opacity);
    }
    if (v(0x5df4) === 1)
      for (let i = 0; i < 2000; i++) {
        const n = base + i,
          x = s.get(0x54d400 + n * 8),
          y = s.get(0x54d404 + n * 8),
          boundary =
            (v(0x5df8) -
              Math.trunc(Math.imul((y - 1000) | 0, (v(0x5dfc) - v(0x5df8)) | 0) / 2000) -
              x) |
            0;
        if (s.get(0x570e60 + n * 4) !== 0 && boundary > 0) s.put(0x570e60 + n * 4, 0);
      }
  }
}
/** 14001b630. Native screen-space vertex format: x,y,z,r,g,b,a,u,v. */
export function drawRain(s: NoahState, side: number, bank: number): TriangleDraw | undefined {
  const v = (a: number) => s.variable(a / 4 + bank * 20),
    count = s.get(0x56cdb8 + bank * 4) >>> 0;
  s.put(0x56ca80 + bank * 4, v(0x5dd0));
  if (!v(0x5dcc) || !count) return;
  if (count > 2000) throw new Error('Native rain count exceeds its 2000-particle bank');
  const angle = mul(mul(f(v(0x5dd0)), f(Math.PI)), 1 / 32768),
    rotation = mul(mul(f(v(0x5de0)), f(Math.PI)), 1 / 32768),
    cos = f(Math.cos(angle)),
    sin = f(Math.sin(angle)),
    rc = f(Math.cos(rotation)),
    rs = f(Math.sin(rotation));
  particleRotation(s, 0x1d7d190, v(0x5dd0));
  particleRotation(s, 0x1d7d1d0, v(0x5de0));
  const vertices: number[] = [],
    rgb = v(0x5dc0) >>> 0,
    red = div((rgb >>> 16) & 255, 255),
    green = div((rgb >>> 8) & 255, 255),
    blue = div(rgb & 255, 255);
  const read = (a: number) => s.view(a, 4).getFloat32(0, true);
  s.put(0x56ca98, 0);
  s.put(0x578b8c, 0);
  for (let i = 0; i < count; i++) {
    const n = bank * 2000 + i,
      opacity = s.get(0x570e60 + n * 4);
    if (!opacity) continue;
    const a = 0x57ae30 + n * 12,
      x = read(a),
      y = read(a + 4),
      z = read(a + 8),
      z0 = sub(z, 128),
      z1 = add(z, 128),
      yy = mul(y, sin);
    const depth0 = add(add(add(add(mul(z0, cos), yy), 0), f(v(0x5dd8))), 1000),
      depth1 = add(add(add(add(mul(z1, cos), yy), 0), f(v(0x5dd8))), 1000);
    if (!(
      depth0 >= 40 &&
      depth1 >= 40 &&
      depth0 <= f(v(0x5de4) >>> 0) &&
      depth1 <= f(v(0x5de4) >>> 0)
    ))
      continue;
    let x0 = div(mul(x, 300), depth0),
      x1 = div(mul(x, 300), depth1),
      y0 = div(mul(add(add(mul(z0, -sin), mul(y, cos)), 0), 300), depth0),
      y1 = div(mul(add(add(mul(z1, -sin), mul(y, cos)), 0), 300), depth1);
    if ((v(0x5de0) << 16) >> 16 !== 0) {
      const a0 = mul(y0, -rs),
        a1 = mul(y1, -rs);
      y0 = add(add(mul(y0, rc), mul(x0, rs)), 0);
      x0 = add(add(mul(x0, rc), a0), 0);
      y1 = add(add(mul(y1, rc), mul(x1, rs)), 0);
      x1 = add(add(mul(x1, rc), a1), 0);
    }
    x0 = add(x0, 640);
    x1 = add(x1, 640);
    y0 = add(y0, 360);
    y1 = add(y1, 360);
    const midpoint = mul(add(x1, x0), 0.5),
      depth = mul(add(depth1, depth0), 0.5),
      occlusion = v(0x5e00);
    if (occlusion === 1) {
      if (midpoint < 860) {
        if (add(div(mul(sub(midpoint, 330), 760), 530), 40) > depth) continue;
      } else if (midpoint < 940 || sub(800, div(mul(sub(midpoint, 940), 760), 210)) > depth)
        continue;
    } else if (occlusion === 2) {
      if (midpoint > 154 && midpoint < 340) {
        if (add(div(mul(sub(midpoint, 154), 760), 186), 40) > depth) continue;
      } else if (midpoint > 466 || (midpoint >= 340 && depth < 800)) continue;
    }
    const d = trunc(depth0);
    if (side === 0 ? d <= v(0x5df0) : d > v(0x5df0)) continue;
    if (d >= 1200) continue;
    const fade = d < 100 ? 256 : Math.trunc(((1200 - d) * 224) / 1100) + 32,
      alpha = Math.trunc(Math.imul(Math.imul(fade, opacity), v(0x5dcc)) / 65536),
      tail = Math.min(255, Math.max(0, alpha - 20)),
      head = Math.min(255, alpha),
      width = sub(4, div(f(d), 2000));
    if (!(
      x0 >= -200 &&
      y0 >= -200 &&
      x0 <= 1480 &&
      y0 <= 920 &&
      x1 >= -200 &&
      y1 >= -200 &&
      x1 <= 1480 &&
      y1 <= 920
    ))
      continue;
    const vertex = (xx: number, yy: number, aa: number, u: number, vv: number) =>
      vertices.push(mul(xx, 1.5), mul(yy, 1.5), 1, red, green, blue, div(aa, 255), u, vv);
    vertex(sub(x1, width), y1, tail, 343, 194);
    vertex(sub(x0, width), y0, head, 343, 255);
    vertex(add(x1, width), y1, tail, 361, 194);
    vertex(add(x1, width), y1, tail, 361, 194);
    vertex(sub(x0, width), y0, head, 343, 255);
    vertex(add(x0, width), y0, head, 361, 255);
  }
  s.put(0x56ca98, vertices.length / 9);
  s.put(0x578b8c, vertices.length / 27);
  if (v(0x5e0c) === 1) s.put(0x587344, 0);
  if (vertices.length) {
    s.triangleVertices.set(vertices);
    return submitTriangles(s, 82, vertices.length / 27);
  }
}
/** Rain calls in 140012470: independent priority tests, including duplicate passes. */
export function rainAtPriority(s: NoahState, priority: number): TriangleDraw[] {
  const out: TriangleDraw[] = [];
  for (const base of [0x5de8, 0x5e04])
    for (let bank = 0; bank < 2; bank++)
      for (const side of [1, 0])
        if (s.variable((base + bank * 80 + side * 4) / 4) === priority) {
          const draw = drawRain(s, side, bank);
          if (draw) out.push(draw);
        }
  return out;
}
