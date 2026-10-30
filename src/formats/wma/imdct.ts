// Derived from FFmpeg 7.1.1 libavutil/tx; LGPL-2.1-or-later. See NOTICE and LICENSE.
const f = Math.fround;
const cosineTables = new Map<number, Float32Array>();
const windows = new Map<number, Float32Array>();
export interface MdctMemory {
  i32(length: number): Int32Array;
  f32(length: number): Float32Array;
}

/** Sine-window initialization rounds the angle before evaluating sine, matching
 * the decoder's `sinf(double_expression)` conversion. */
export function wmaSineWindow(length: number): Float32Array {
  if (!Number.isSafeInteger(length) || length < 128 || length > 2048 || length & (length - 1))
    throw Error('Unsupported WMA window');
  let window = windows.get(length);
  if (!window) {
    window = new Float32Array(length);
    const frequency = Math.PI / (2 * length);
    for (let i = 0; i < length; i++) window[i] = Math.sin(f((i + 0.5) * frequency));
    windows.set(length, window);
  }
  return window;
}
function cosines(length: number): Float32Array {
  let table = cosineTables.get(length);
  if (!table) {
    table = new Float32Array(length / 4 + 1);
    const frequency = (2 * Math.PI) / length;
    for (let i = 0; i < length / 4; i++) table[i] = Math.cos(i * frequency);
    cosineTables.set(length, table);
  }
  return table;
}

function permutation(i: number, length: number): number {
  length >>= 1;
  if (length <= 1) return i & 1;
  if (!(i & length)) return permutation(i, length) * 2;
  length >>= 1;
  return permutation(i, length) * 4 + 1 - 2 * (Number(!(i & length)) ^ 1);
}

/** Power-of-two float IMDCT, preserving the split-radix decoder's operation order.
 * Callers supply non-aliasing coefficient/output arrays; no transform call allocates. */
export class InverseMdct {
  private readonly map: Int32Array;
  private readonly pre: Float32Array;
  private readonly post: Float32Array;
  constructor(
    readonly length: number,
    scale: number,
  ) {
    if (
      !Number.isSafeInteger(length) ||
      length < 128 ||
      length > 2048 ||
      length & (length - 1) ||
      !Number.isFinite(scale)
    )
      throw Error('Unsupported WMA IMDCT');
    const half = length / 2;
    this.map = new Int32Array(half);
    this.pre = new Float32Array(length);
    this.post = new Float32Array(length);
    const theta = (scale < 0 ? half : 0) + 1 / 8;
    scale = Math.sqrt(Math.abs(scale));
    for (let i = 0; i < half; i++) {
      const alpha = ((Math.PI / 2) * (i + theta)) / half;
      this.post[i * 2] = Math.cos(alpha) * scale;
      this.post[i * 2 + 1] = Math.sin(alpha) * scale;
    }
    for (let i = 0; i < half; i++) {
      const index = -permutation(i, half) & (half - 1);
      this.map[i] = index * 2;
      this.pre[i * 2] = this.post[index * 2]!;
      this.pre[i * 2 + 1] = this.post[index * 2 + 1]!;
    }
    for (let n = 8; n <= half; n *= 2) cosines(n);
  }

  /** The middle half of the full IMDCT, in `length` float samples. */
  half(input: Float32Array, output: Float32Array, offset = 0): void {
    const length = this.length,
      half = length / 2,
      quarter = length / 4;
    if (
      input.length < length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      output.length < offset + length
    )
      throw Error('Short WMA IMDCT buffer');
    for (let i = 0; i < half; i++) {
      const k = this.map[i]!,
        re = input[length - 1 - k]!,
        im = input[k]!;
      const wr = this.pre[i * 2]!,
        wi = this.pre[i * 2 + 1]!;
      output[offset + i * 2] = f(f(re * wr) - f(im * wi));
      output[offset + i * 2 + 1] = f(f(re * wi) + f(im * wr));
    }
    fft(output, offset, half);
    for (let i = 0; i < quarter; i++) {
      const i0 = (quarter + i) * 2,
        i1 = (quarter - i - 1) * 2;
      const re1 = output[offset + i1 + 1]!,
        im1 = output[offset + i1]!;
      const re0 = output[offset + i0 + 1]!,
        im0 = output[offset + i0]!;
      output[offset + i1] = f(f(re1 * this.post[i1 + 1]!) - f(im1 * this.post[i1]!));
      output[offset + i0 + 1] = f(f(re1 * this.post[i1]!) + f(im1 * this.post[i1 + 1]!));
      output[offset + i0] = f(f(re0 * this.post[i0 + 1]!) - f(im0 * this.post[i0]!));
      output[offset + i1 + 1] = f(f(re0 * this.post[i0]!) + f(im0 * this.post[i0 + 1]!));
    }
  }

  /** Full IMDCT, in `2 * length` float samples. */
  full(input: Float32Array, output: Float32Array): void {
    const length = this.length;
    if (output.length < length * 2) throw Error('Short WMA IMDCT buffer');
    this.half(input, output, length / 2);
    for (let i = 0; i < length / 2; i++) {
      output[i] = -output[length - i - 1]!;
      output[length * 2 - i - 1] = output[length + i]!;
    }
  }

  /** Copies the immutable pointer plan into a private Rust audio arena. */
  copyPlan(memory: MdctMemory): Int32Array {
    const plan = memory.i32(12),
      map = memory.i32(this.map.length);
    map.set(this.map);
    const copy = (source: Float32Array) => {
      const target = memory.f32(source.length);
      target.set(source);
      return target.byteOffset;
    };
    plan[0] = this.length;
    plan[1] = map.byteOffset;
    plan[2] = copy(this.pre);
    plan[3] = copy(this.post);
    for (let n = 8, i = 4; n <= this.length / 2; n *= 2, i++) plan[i] = copy(cosines(n));
    return plan;
  }
}

function fft4(z: Float32Array, b: number): void {
  const t3 = f(z[b]! - z[b + 2]!),
    t1 = f(z[b]! + z[b + 2]!);
  const t8 = f(z[b + 6]! - z[b + 4]!),
    t6 = f(z[b + 6]! + z[b + 4]!);
  z[b + 4] = f(t1 - t6);
  z[b] = f(t1 + t6);
  const t4 = f(z[b + 1]! - z[b + 3]!),
    t2 = f(z[b + 1]! + z[b + 3]!);
  const t7 = f(z[b + 5]! - z[b + 7]!),
    t5 = f(z[b + 5]! + z[b + 7]!);
  z[b + 7] = f(t4 - t8);
  z[b + 3] = f(t4 + t8);
  z[b + 6] = f(t3 - t7);
  z[b + 2] = f(t3 + t7);
  z[b + 5] = f(t2 - t5);
  z[b + 1] = f(t2 + t5);
}

function butterflies(
  z: Float32Array,
  a0: number,
  a1: number,
  a2: number,
  a3: number,
  t1: number,
  t2: number,
  t5: number,
  t6: number,
): void {
  const r0 = z[a0]!,
    i0 = z[a0 + 1]!,
    r1 = z[a1]!,
    i1 = z[a1 + 1]!;
  const t3 = f(t5 - t1);
  t5 = f(t5 + t1);
  z[a2] = f(r0 - t5);
  z[a0] = f(r0 + t5);
  z[a3 + 1] = f(i1 - t3);
  z[a1 + 1] = f(i1 + t3);
  const t4 = f(t2 - t6);
  t6 = f(t2 + t6);
  z[a3] = f(r1 - t4);
  z[a1] = f(r1 + t4);
  z[a2 + 1] = f(i0 - t6);
  z[a0 + 1] = f(i0 + t6);
}

function transform(
  z: Float32Array,
  a0: number,
  a1: number,
  a2: number,
  a3: number,
  wr: number,
  wi: number,
): void {
  const ar = z[a2]!,
    ai = z[a2 + 1]!,
    br = z[a3]!,
    bi = z[a3 + 1]!;
  const t1 = f(f(ar * wr) - f(ai * -wi)),
    t2 = f(f(ar * -wi) + f(ai * wr));
  const t5 = f(f(br * wr) - f(bi * wi)),
    t6 = f(f(br * wi) + f(bi * wr));
  butterflies(z, a0, a1, a2, a3, t1, t2, t5, t6);
}

function fft(z: Float32Array, b: number, n: number): void {
  if (n === 4) {
    fft4(z, b);
    return;
  }
  if (n === 8) {
    fft4(z, b);
    const t1 = f(z[b + 8]! - -z[b + 10]!),
      t2 = f(z[b + 9]! - -z[b + 11]!);
    z[b + 10] = f(z[b + 8]! + -z[b + 10]!);
    z[b + 11] = f(z[b + 9]! + -z[b + 11]!);
    const t5 = f(z[b + 12]! - -z[b + 14]!),
      t6 = f(z[b + 13]! - -z[b + 15]!);
    z[b + 14] = f(z[b + 12]! + -z[b + 14]!);
    z[b + 15] = f(z[b + 13]! + -z[b + 15]!);
    butterflies(z, b, b + 4, b + 8, b + 12, t1, t2, t5, t6);
    const c = cosines(8)[1]!;
    transform(z, b + 2, b + 6, b + 10, b + 14, c, c);
    return;
  }
  const quarter = n / 4,
    table = cosines(n);
  fft(z, b, n / 2);
  fft(z, b + quarter * 4, quarter);
  fft(z, b + quarter * 6, quarter);
  if (n === 16) {
    butterflies(z, b, b + 8, b + 16, b + 24, z[b + 16]!, z[b + 17]!, z[b + 24]!, z[b + 25]!);
    transform(z, b + 4, b + 12, b + 20, b + 28, table[2]!, table[2]!);
    transform(z, b + 2, b + 10, b + 18, b + 26, table[1]!, table[3]!);
    transform(z, b + 6, b + 14, b + 22, b + 30, table[3]!, table[1]!);
  } else
    for (let i = 0; i < quarter; i++) {
      transform(
        z,
        b + i * 2,
        b + (i + quarter) * 2,
        b + (i + quarter * 2) * 2,
        b + (i + quarter * 3) * 2,
        table[i]!,
        table[quarter - i]!,
      );
    }
}
