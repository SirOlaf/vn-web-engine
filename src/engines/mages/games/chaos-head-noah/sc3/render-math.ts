import {nativeTrigData} from './native-trig-data.js';
export const f = Math.fround;
export const add = (a: number, b: number) => f(a + b),
  sub = (a: number, b: number) => f(a - b),
  mul = (a: number, b: number) => f(a * b),
  div = (a: number, b: number) => f(a / b);
export const trunc = (v: number) =>
  !Number.isFinite(v) || v >= 2147483648 || v < -2147483648 ? -2147483648 : Math.trunc(v);
/** 14001f610 and the inlined quarter-wave lookup in 140018110. */
export function nativeSine(angle: number): number {
  const n = ((angle + 8) >>> 4) & 4095,
    q = n & 3072,
    at = (i: number) => nativeTrigData[(0x1d7850 - 0x1d6820) / 2 + i]!;
  return q === 0
    ? at(n)
    : q === 1024
      ? n === 1024
        ? 65536
        : at(2048 - n)
      : q === 2048
        ? -at(n - 2048)
        : n === 3072
          ? -65536
          : -at(4096 - n);
}
/** Native column-major storage and operation order, 14007d2b0. */
export function matrixProduct(a: Float32Array, b: Float32Array): Float32Array {
  const r = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      r[col * 4 + row] = add(
        add(
          add(mul(a[row]!, b[col * 4]!), mul(a[4 + row]!, b[col * 4 + 1]!)),
          mul(a[8 + row]!, b[col * 4 + 2]!),
        ),
        mul(a[12 + row]!, b[col * 4 + 3]!),
      );
  return r;
}
export function rotation(x: number, y: number, z: number): Float32Array {
  const angle = (v: number) => mul(mul(f(v), f(Math.PI)), 1 / 32768),
    ax = angle(x),
    ay = angle(y),
    az = angle(z),
    cx = f(Math.cos(ax)),
    sx = f(Math.sin(ax)),
    cy = f(Math.cos(ay)),
    sy = f(Math.sin(ay)),
    cz = f(Math.cos(az)),
    sz = f(Math.sin(az));
  return new Float32Array([
    mul(cz, cy),
    sub(mul(mul(sy, sx), cz), mul(sz, cx)),
    add(mul(mul(sy, cx), cz), mul(sz, sx)),
    0,
    mul(sz, cy),
    add(mul(mul(sy, sx), sz), mul(cz, cx)),
    sub(mul(mul(sy, cx), sz), mul(cz, sx)),
    0,
    -sy,
    mul(cy, sx),
    mul(cy, cx),
    0,
    0,
    0,
    0,
    1,
  ]);
}
/** 140023760; the native flattened 2D matrix preserves X/Y rotation effects. */
export function backgroundMatrix(
  x: number,
  y: number,
  scale: number,
  rx: number,
  ry: number,
  rz: number,
): Float32Array {
  const m = matrixProduct(
    rotation(rx, ry, rz),
    new Float32Array([
      div(f(scale), 1000),
      0,
      0,
      0,
      0,
      div(f(scale), 1000),
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    ]),
  );
  m[8] = 0;
  m[9] = 0;
  m[10] = 1;
  m[11] = 0;
  m[2] = 0;
  m[6] = 0;
  m[7] = add(f(y), m[7]!);
  m[3] = add(f(x), m[3]!);
  return m;
}
/** 140022080, transposed for GLSL's column-vector multiplication; D3D Z is [0,1]. */
export function clipMatrix(m: Float32Array): Float32Array {
  const p = matrixProduct(
      m,
      new Float32Array([div(2, 1920), 0, 0, -1, 0, div(-2, 1080), 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]),
    ),
    r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let row = 0; row < 4; row++)
      r[c * 4 + row] = row === 2 ? sub(mul(2, p[8 + c]!), p[12 + c]!) : p[row * 4 + c]!;
  return r;
}
