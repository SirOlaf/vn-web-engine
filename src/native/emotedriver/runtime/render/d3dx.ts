import type {D3dViewport} from '../../../d3d9/contract.js';

/**
 * The D3DX 9 math functions `emotedriver.dll` imports (IAT 0x1006f104–0x1006f110). Matrices
 * are 16 floats, row-major (`D3DXMATRIX`), row vectors multiply from the left. Results are
 * rounded to single precision at every store, as D3DX writes `float` members.
 */

const f = Math.fround;

/** `D3DXMatrixMultiply(out, a, b)`: out = a · b. `out` may alias `a` or `b`. */
export function d3dxMatrixMultiply(
  a: Float32Array,
  b: Float32Array,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      r[i * 4 + j] = f(
        a[i * 4]! * b[j]! +
          a[i * 4 + 1]! * b[4 + j]! +
          a[i * 4 + 2]! * b[8 + j]! +
          a[i * 4 + 3]! * b[12 + j]!,
      );
  out.set(r);
  return out;
}

/** `D3DXMatrixTranspose(out, m)`. `out` may alias `m`. */
export function d3dxMatrixTranspose(
  m: Float32Array,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[j * 4 + i] = m[i * 4 + j]!;
  out.set(r);
  return out;
}

export type Vec3 = readonly [number, number, number];

function normalize(v: Vec3): [number, number, number] {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length === 0) return [0, 0, 0];
  return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])];
}

const dot = (a: Vec3, b: Vec3): number => f(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);

/** `D3DXMatrixLookAtLH(out, eye, at, up)`. */
export function d3dxMatrixLookAtLH(eye: Vec3, at: Vec3, up: Vec3): Float32Array {
  const z = normalize([f(at[0] - eye[0]), f(at[1] - eye[1]), f(at[2] - eye[2])]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return Float32Array.of(
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  );
}

/**
 * `D3DXVec3Project(out, v, viewport, projection, view, world)`: transforms `v` by
 * world · view · projection, divides by w and maps to the viewport.
 */
export function d3dxVec3Project(
  v: Vec3,
  viewport: D3dViewport,
  projection: Float32Array,
  view: Float32Array,
  world: Float32Array,
): [number, number, number] {
  const m = d3dxMatrixMultiply(d3dxMatrixMultiply(world, view), projection);
  const w = f(v[0] * m[3]! + v[1] * m[7]! + v[2] * m[11]! + m[15]!);
  const x = f(f(v[0] * m[0]! + v[1] * m[4]! + v[2] * m[8]! + m[12]!) / w),
    y = f(f(v[0] * m[1]! + v[1] * m[5]! + v[2] * m[9]! + m[13]!) / w),
    z = f(f(v[0] * m[2]! + v[1] * m[6]! + v[2] * m[10]! + m[14]!) / w);
  return [
    f(viewport.x + f(f(1 + x) * viewport.width) / 2),
    f(viewport.y + f(f(1 - y) * viewport.height) / 2),
    f(viewport.minZ + f(z * f(viewport.maxZ - viewport.minZ))),
  ];
}
