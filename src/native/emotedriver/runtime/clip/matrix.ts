import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';

/** Components consumed by the native local-frame composer, independent of node storage. */
export interface EmoteMatrixTransform {
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly angle: number;
  readonly zoomX: number;
  readonly zoomY: number;
  readonly slantX: number;
  readonly slantY: number;
}

/** Scalar matrix storage supplied by a layer implementation. */
export interface EmoteMatrixValues {
  readonly m00: number;
  readonly m01: number;
  readonly m10: number;
  readonly m11: number;
}
export interface EmoteMatrixTarget {
  setMatrix(m00: number, m01: number, m10: number, m11: number): void;
}
type MatrixOutput = Float32Array | EmoteMatrixTarget;
function store(out: MatrixOutput, a: number, b: number, c: number, d: number): void {
  if (out instanceof Float32Array) {
    out[0] = a;
    out[1] = b;
    out[2] = c;
    out[3] = d;
  } else out.setMatrix(Math.fround(a), Math.fround(b), Math.fround(c), Math.fround(d));
}

const f = Math.fround;
const X64_DEGREES = f((Math.PI * 2) / 360);
function x64Image(sha: string): boolean {
  return (
    sha === EMOTEDRIVER_X64_SHA256 ||
    (sha !== EMOTEDRIVER_X86_SHA256 && emoteBuild(sha) === EMOTEDRIVER_X64_SHA256)
  );
}

/** 0x1003dd30: 2×2 frame from flips, rotation, zoom and slant in `transformOrder`. */
export function composeEmoteMatrix(
  s: EmoteMatrixTransform,
  transformOrder: readonly number[],
  out: MatrixOutput,
  driverSha256 = EMOTEDRIVER_X86_SHA256,
): void {
  if (x64Image(driverSha256)) {
    composeX64(s, transformOrder, out);
    return;
  }
  const m = out instanceof Float32Array ? out : new Float32Array(4);
  m[0] = 1;
  m[1] = 0;
  m[2] = 0;
  m[3] = 1;
  for (const op of transformOrder) {
    switch (op) {
      case 0:
        if (s.flipX) {
          m[0] = -m[0]!;
          m[1] = -m[1]!;
        }
        if (s.flipY) {
          m[2] = -m[2]!;
          m[3] = -m[3]!;
        }
        break;
      case 1:
        if (s.angle !== 0) {
          const rad = f((s.angle * 3.1415927410125732 * 2) / 360);
          const sn = f(Math.sin(rad)),
            cs = f(Math.cos(rad));
          const m0: number = m[0]!,
            m1: number = m[1]!,
            m2: number = m[2]!,
            m3: number = m[3]!;
          m[0] = m0 * cs - m2 * sn;
          m[1] = m1 * cs - m3 * sn;
          m[2] = m0 * sn + m2 * cs;
          m[3] = m1 * sn + m3 * cs;
        }
        break;
      case 2:
        if (s.zoomX !== 1 || s.zoomY !== 1) {
          m[0] = m[0]! * s.zoomX;
          m[1] = m[1]! * s.zoomX;
          m[2] = m[2]! * s.zoomY;
          m[3] = m[3]! * s.zoomY;
        }
        break;
      case 3:
        if (s.slantX !== 0 || s.slantY !== 0) {
          const m0: number = m[0]!,
            m1: number = m[1]!;
          m[0] = m[2]! * s.slantX + m0;
          m[1] = m[3]! * s.slantX + m1;
          m[2] = m0 * s.slantY + m[2]!;
          m[3] = m1 * s.slantY + m[3]!;
        }
        break;
    }
  }
  if (out !== m) store(out, m[0]!, m[1]!, m[2]!, m[3]!);
}

/** out = a · b (row-major 2×2), with caller-selected array or scalar storage. */
export function multiplyEmoteMatrices(
  a: Float32Array | EmoteMatrixValues,
  b: Float32Array | EmoteMatrixValues,
  out: MatrixOutput,
  driverSha256 = EMOTEDRIVER_X86_SHA256,
): void {
  const x64 = x64Image(driverSha256);
  let a0: number,
    a1: number,
    a2: number,
    a3: number,
    b0: number,
    b1: number,
    b2: number,
    b3: number;
  if (a instanceof Float32Array) {
    a0 = a[0]!;
    a1 = a[1]!;
    a2 = a[2]!;
    a3 = a[3]!;
  } else {
    a0 = a.m00;
    a1 = a.m01;
    a2 = a.m10;
    a3 = a.m11;
  }
  if (b instanceof Float32Array) {
    b0 = b[0]!;
    b1 = b[1]!;
    b2 = b[2]!;
    b3 = b[3]!;
  } else {
    b0 = b.m00;
    b1 = b.m01;
    b2 = b.m10;
    b3 = b.m11;
  }
  const r0 = x64 ? b0 * a0 + b2 * a1 : a1 * b2 + a0 * b0,
    r1 = x64 ? a0 * b1 + a1 * b3 : a0 * b1 + b3 * a1,
    r2 = x64 ? b0 * a2 + b2 * a3 : a2 * b0 + a3 * b2,
    r3 = x64 ? a2 * b1 + a3 * b3 : b1 * a2 + a3 * b3;
  store(out, r0, r1, r2, r3);
}

/** 0x180041de0: x64 scalar-register frame composition. */
function composeX64(
  state: EmoteMatrixTransform,
  transformOrder: readonly number[],
  out: MatrixOutput,
): void {
  let m00 = 1,
    m01 = 0,
    m10 = 0,
    m11 = 1;
  for (const step of transformOrder) {
    switch (step) {
      case 0:
        if (state.flipX) {
          m00 = -m00;
          m01 = -m01;
        }
        if (state.flipY) {
          m10 = -m10;
          m11 = -m11;
        }
        break;
      case 1: {
        if (state.angle !== 0) {
          const r = f(state.angle * X64_DEGREES);
          const s = f(Math.sin(r)),
            c = f(Math.cos(r));
          const a00 = f(m00 * c - m10 * s),
            a10 = f(m00 * s + m10 * c),
            a01 = f(m01 * c - m11 * s),
            a11 = f(m01 * s + m11 * c);
          m00 = a00;
          m10 = a10;
          m01 = a01;
          m11 = a11;
        }
        break;
      }
      case 2:
        if (state.zoomX !== 1 || state.zoomY !== 1) {
          m00 = f(m00 * state.zoomX);
          m01 = f(m01 * state.zoomX);
          m10 = f(m10 * state.zoomY);
          m11 = f(m11 * state.zoomY);
        }
        break;
      case 3:
        if (state.slantX !== 0 || state.slantY !== 0) {
          const a00 = f(m00 + state.slantX * m10),
            a01 = f(m01 + state.slantX * m11),
            a10 = f(m10 + state.slantY * m00),
            a11 = f(m11 + state.slantY * m01);
          m00 = a00;
          m01 = a01;
          m10 = a10;
          m11 = a11;
        }
        break;
    }
  }
  store(out, m00, m01, m10, m11);
}
