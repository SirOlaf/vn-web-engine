import {nativeBlend} from './render-state.js';
import type {NoahState} from './noah-state.js';
import type {TriangleDraw} from '../../../../../graphics/triangle-draw.js';
import {add, sub, mul, div} from './render-math.js';
/** 140023e50 mutates its global buffer, including repeated normalization on reuse. */
export function submitTriangles(
  s: NoahState,
  texture: number,
  count: number,
  fragment?: string,
): TriangleDraw {
  const a = 0x1d1b200 + texture * 0x1b0,
    u = (o: number) => s.view(a + o, 2).getUint16(0, true),
    width = div(mul(u(0x72), u(0x76)), u(0x68)),
    height = div(mul(u(0x74), u(0x78)), u(0x6a)),
    v = s.triangleVertices;
  if (count < 0 || count * 27 > v.length)
    throw new Error('Native triangle submission exceeds vertex allocation');
  for (let i = 0; i < count * 27; i += 9) {
    v[i] = div(sub(add(v[i]!, v[i]!), 1920), 1920);
    v[i + 1] = div(sub(1080, add(v[i + 1]!, v[i + 1]!)), 1080);
    v[i + 7] = div(v[i + 7]!, width);
    v[i + 8] = div(v[i + 8]!, height);
  }
  const vertices = v.slice(0, count * 27);
  for (let i = 65536; i < count * 3; i++)
    vertices.set(v.subarray((i & 65535) * 9, (i & 65535) * 9 + 9), i * 9);
  return {
    kind: 'triangles',
    texture,
    blendState: nativeBlend(),
    vertices,
    normalizedUV: true,
    fragment,
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, -1, 1]),
  };
}
