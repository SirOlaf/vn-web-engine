import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {f, add, sub, mul, div, trunc} from './render-math.js';
import {submitTriangles} from './triangle-submit.js';
/** 14001c130: both 2000-record banks advance independently of visible count. */
export function advanceSnow(s: NoahState): void {
  const read = (a: number) => s.view(a, 4).getFloat32(0, true),
    write = (a: number, v: number) => s.view(a, 4).setFloat32(0, v, true),
    rand = () => s.random15() & 32767;
  for (let bank = 0; bank < 2; bank++) {
    const v = (a: number) => s.variable(a / 4 + bank * 20),
      count = v(0x5e60) >>> 0,
      density = v(0x5e74) >>> 0,
      speed = mul(f(v(0x5e6c) >>> 0), 1 / 65536);
    s.put(0x555108 + bank * 4, count);
    write(0x56ca90 + bank * 4, speed);
    if (!count) continue;
    if (count > 2000) s.put(0x555108 + bank * 4, 2000);
    for (let i = 0; i < 2000; i++) {
      const n = bank * 2000 + i,
        a = 0x559200 + n * 20,
        z = sub(read(a + 8), speed);
      write(a + 8, z);
      write(a, add(read(a + 12), read(a)));
      write(a + 4, add(read(a + 4), read(a + 16)));
      let target = 256;
      if (z < -1500) {
        write(a, ((rand() * 4000) >>> 15) - 2000);
        write(a + 8, 1500);
        write(a + 4, ((rand() * 2000) >>> 15) - 1000);
        write(a + 12, mul((rand() >>> 2) - 4096, 1 / 65536));
        write(a + 16, mul((rand() >>> 2) - 4096, 1 / 65536));
        s.put(0x555110 + n * 4, 0);
        target = 0;
        s.put(0x545660 + n * 4, (rand() * 24) >>> 15);
        s.put(0x578b90 + n * 2, (rand() >>> 2) << 3, 2);
      } else if (sub(1500, f(density)) <= z) {
        const edge = sub(1756, f(density));
        if (z < edge) target = 256 - trunc(sub(edge, z));
      } else target = 0;
      s.put(0x574cf0 + n * 4, target);
      const current = s.get(0x555110 + n * 4);
      s.put(
        0x555110 + n * 4,
        current === 512
          ? target
          : current < target
            ? Math.min(target, (current + 8) | 0)
            : current > target
              ? Math.max(target, current - 8)
              : current,
      );
    }
  }
}
/** The three native mutable rotation matrices at 141d7d190..141d7d24f. */
export function particleRotation(
  s: NoahState,
  address: number,
  angle: number,
  preserveTranslation = false,
): [number, number] {
  const radians = mul(mul(f(angle), f(Math.PI)), 1 / 32768),
    c = f(Math.cos(radians)),
    sn = f(Math.sin(radians)),
    m = [c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++)
    if (!preserveTranslation || (i !== 3 && i !== 7))
      s.view(address + i * 4, 4).setFloat32(0, m[i]!, true);
  return [c, sn];
}
/** 14001c4b0, including the atlas path selected by the byte at variable offset 64d4. */
export function drawSnow(s: NoahState, side: number, bank: number): TriangleDraw | undefined {
  const v = (a: number) => s.variable(a / 4 + bank * 20),
    count = s.get(0x555108 + bank * 4) >>> 0;
  s.put(0x555100 + bank * 4, v(0x5e64));
  if (v(0x5e68) === 0 || count === 0) return;
  const mask = s.variableBytes[0x64d4 + bank]!,
    slot = mask && !(mask & (mask - 1)) ? 32 - Math.clz32(mask) : 0,
    texture = slot ? s.variable(0xd47 + slot) : 82;
  const [c, sn] = particleRotation(s, 0x1d7d190, v(0x5e64)),
    [rc, rs] = particleRotation(s, 0x1d7d1d0, v(0x5e78)),
    read = (a: number) => s.view(a, 4).getFloat32(0, true);
  const rgb = v(0x5e98),
    r = div((rgb >>> 16) & 255, 255),
    g = div((rgb >>> 8) & 255, 255),
    b = div(rgb & 255, 255),
    vertices: number[] = [];
  s.put(0x56ca98, 0);
  s.put(0x578b8c, 0);
  for (let i = 0; i < count; i++) {
    const n = bank * 2000 + i,
      a = 0x559200 + n * 20,
      x = read(a),
      y = read(a + 4),
      z = read(a + 8),
      depth = add(add(add(add(mul(y, sn), mul(z, c)), 0), f(v(0x5e70))), 1000),
      opacityAddress = 0x56cfe0 + n * 4;
    if (!(depth >= 10 && depth <= add(f(v(0x5e7c) >>> 0), 1000))) {
      s.put(opacityAddress, 0);
      continue;
    }
    let occlusion = s.get(0x555110 + n * 4) === 0 ? 4 : 0;
    if (depth < 40) occlusion = 1;
    if (depth > f(v(0x5e7c) >>> 0)) occlusion = 1;
    else if (occlusion === 0 && v(0x5e8c) === 1) {
      if (
        depth < sub(1000, div(mul(add(x, 640), 2000), 320)) ||
        depth < sub(1000, div(mul(sub(x, 640), 2000), -320)) ||
        depth < 600
      )
        occlusion = 1;
    }
    let px = div(mul(x, 300), depth),
      py = div(mul(add(add(mul(y, c), mul(z, -sn)), 0), 300), depth),
      size = div(7200, depth);
    const d = trunc(depth);
    if (side === 0 ? d <= v(0x5e88) : d > v(0x5e88)) continue;
    const fade =
        occlusion === 0
          ? d < 600
            ? 256
            : d < 1800
              ? Math.trunc(((1800 - d) * 256) / 1200)
              : 0
          : 0,
      target = Math.min(
        255,
        Math.trunc(Math.imul(Math.imul(s.get(0x555110 + n * 4), fade), v(0x5e68)) / 65536),
      ),
      previous = s.get(opacityAddress);
    let opacity =
      previous < target
        ? Math.min(target, previous + 2)
        : previous > target
          ? Math.max(target, previous - occlusion)
          : previous;
    if (opacity < 0) opacity = 0;
    s.put(opacityAddress, opacity);
    if (!opacity) continue;
    const alpha = div(Math.min(255, opacity), 255);
    if ((v(0x5e78) << 16) >> 16 !== 0) {
      const xx = add(add(mul(py, -rs), mul(px, rc)), 0);
      py = add(add(mul(py, rc), mul(px, rs)), 0);
      px = xx;
    }
    px = add(px, 640);
    py = add(py, 360);
    let u0 = 257,
      v0 = 193,
      u1 = 319,
      v1 = 255,
      pc = 1,
      ps = 0;
    if (slot) {
      size = mul(size, 16);
      const tile = s.get(0x545660 + n * 4) >>> 0,
        tx = (tile % 12) * 80,
        ty = Math.trunc(tile / 12) * 80,
        ta = 0x1d1b200 + texture * 0x1b0,
        w = s.view(ta + 0x6c, 2).getUint16(0, true),
        h = s.view(ta + 0x6e, 2).getUint16(0, true);
      u0 = div(f(tx + 1), w);
      u1 = div(f(tx + 79), w);
      v0 = div(f(ty + 1), h);
      v1 = div(f(ty + 79), h);
      [pc, ps] = particleRotation(
        s,
        0x1d7d210,
        s.view(0x578b90 + n * 2, 2).getUint16(0, true),
        true,
      );
    }
    if (!(-size <= px && -size <= py && px <= add(size, 1280) && py <= add(size, 720))) continue;
    size = mul(size, 0.5);
    const left = mul(sub(px, size), 1.5),
      right = mul(add(px, size), 1.5),
      top = mul(sub(py, size), 1.5),
      bottom = mul(add(py, size), 1.5);
    const vertex = (x: number, y: number, u: number, v: number) => {
      if (slot) {
        const xx = sub(x, px),
          yy = sub(y, py);
        x = add(px, add(add(mul(yy, -ps), mul(xx, pc)), read(0x1d7d21c)));
        y = add(py, add(add(mul(yy, pc), mul(xx, ps)), read(0x1d7d22c)));
      }
      vertices.push(x, y, 1, r, g, b, alpha, u, v);
    };
    vertex(left, top, u0, v0);
    vertex(left, bottom, u0, v1);
    vertex(right, top, u1, v0);
    vertex(right, top, u1, v0);
    vertex(left, bottom, u0, v1);
    vertex(right, bottom, u1, v1);
  }
  s.put(0x56ca98, vertices.length / 9);
  s.put(0x578b8c, vertices.length / 27);
  if (vertices.length) {
    s.triangleVertices.set(vertices);
    return submitTriangles(s, texture, vertices.length / 27);
  }
}
