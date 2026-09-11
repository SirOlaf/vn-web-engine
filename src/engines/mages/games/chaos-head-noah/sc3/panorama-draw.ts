import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {f, add, sub, mul, div, trunc, clipMatrix} from './render-math.js';
import {nativeBlend} from './render-state.js';
const faces = [
  [0, 0],
  [0, 90],
  [0, 270],
  [0, 180],
  [90, 0],
  [270, 0],
] as const;
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function axis(s: NoahState, axis: number, angle: number): Float32Array {
  const r = mul(mul(f(angle), f(Math.PI)), 1 / 32768),
    c = f(Math.cos(r)),
    sn = f(Math.sin(r)),
    m =
      axis === 0
        ? new Float32Array([1, 0, 0, 0, 0, c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1])
        : axis === 1
          ? new Float32Array([c, 0, sn, 0, 0, 1, 0, 0, -sn, 0, c, 0, 0, 0, 0, 1])
          : new Float32Array([c, -sn, 0, 0, sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const a = 0x1d7d190 + axis * 64;
  s.bytes(a, 64).set(new Uint8Array(m.buffer));
  return m;
}
function point(m: Float32Array, p: number[]): number[] {
  return [0, 1, 2].map((i) =>
    add(
      add(add(mul(p[1]!, m[i * 4 + 1]!), mul(p[0]!, m[i * 4]!)), mul(p[2]!, m[i * 4 + 2]!)),
      m[i * 4 + 3]!,
    ),
  );
}
/** 140005f40, 1400055f0 and 140005950: six subdivided panorama faces.
 * The native CPU projection removes a triangle unless all three depths exceed 1.
 * 140023950 restores rasterizer state before every mesh; the outer cull change
 * therefore does not cull the submitted faces. */
export function drawPanorama(s: NoahState): TriangleDraw[] {
  const v = (a: number) => s.variable(a / 4),
    opacity = v(0x6c80);
  if (opacity === 0) return [];
  const out: TriangleDraw[] = [];
  for (let face = 0; face < 6; face++) {
    const texture = 168 + face,
      a = 0x1d1b200 + texture * 0x1b0,
      u = (o: number) => s.view(a + o, 2).getUint16(0, true),
      width = trunc(div(mul(u(0x72), u(0x76)), u(0x68))),
      height = trunc(div(mul(u(0x74), u(0x78)), u(0x6a))),
      nx = Math.trunc((width + 63) / 64),
      ny = Math.trunc((height + 63) / 64),
      count = (nx + 1) * (ny + 1),
      points: number[][] = [];
    s.put(0x531fa8, count);
    const [rx, ry] = faces[face]!,
      mx = axis(s, 0, Math.trunc(((rx << 16) >>> 0) / 360)),
      my = axis(s, 1, Math.trunc(((ry << 16) >>> 0) / 360));
    for (let y = 0; y <= ny; y++)
      for (let x = 0; x <= nx; x++)
        points.push(
          point(
            mx,
            point(my, [
              add(f(-Math.trunc(width / 2)), f(x * 64)),
              add(f(-Math.trunc(height / 2)), f(y * 64)),
              f(Math.trunc(width / 2)),
            ]),
          ),
        );
    const xMatrix = axis(s, 0, -v(0x6c70) | 0),
      yMatrix = axis(s, 1, v(0x6c74)),
      zMatrix = axis(s, 2, v(0x6c78)),
      scale = sub(div(f(v(0x6c7c) >>> 0), 10000), div(mul(f(v(0x6c94)), 3), 1000)),
      vertices = new Float32Array(count * 9),
      alpha = div(Math.max(0, Math.min(255, opacity)), 255);
    for (let i = 0; i < count; i++) {
      const p = point(zMatrix, point(xMatrix, point(yMatrix, points[i]!))),
        visible = p[2]! > 1;
      s.put(0x5358e0 + i * 4, +visible);
      if (visible) {
        p[0] = div(mul(p[0]!, 960), p[2]!);
        p[1] = div(mul(p[1]!, 960), p[2]!);
      }
      vertices.set(
        [
          add(f(Math.imul((480 - v(0x6c8c)) | 0, 2)), mul(scale, p[0]!)),
          add(f((Math.imul(v(0x6c90), 2) + 540) | 0), mul(scale, p[1]!)),
          1,
          1,
          1,
          1,
          alpha,
          div(f((i % (nx + 1)) * 64), f(width)),
          div(f(Math.trunc(i / (nx + 1)) * 64), f(height)),
        ],
        i * 9,
      );
    }
    const indices: number[] = [];
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * (nx + 1) + x;
        for (const tri of [
          [i, i + 1, i + nx + 1],
          [i + nx + 1, i + 1, i + nx + 2],
        ]) {
          const t = tri.map((i) => i & 65535);
          if (t.every((i) => s.get(0x5358e0 + i * 4) !== 0)) indices.push(...t);
        }
      }
    s.put(0x531fa0, indices.length);
    s.put(0x532090, indices.length);
    for (let i = 0; i < indices.length; i++) s.put(0x532180 + i * 2, indices[i]!, 2);
    if (indices.length) {
      const expanded = new Float32Array(indices.length * 9);
      indices.forEach((j, i) => expanded.set(vertices.subarray(j * 9, j * 9 + 9), i * 9));
      out.push({
        kind: 'triangles',
        texture,
        vertices: expanded,
        transform: clipMatrix(identity),
        normalizedUV: true,
        blendState: nativeBlend(),
      });
    }
  }
  return out;
}
