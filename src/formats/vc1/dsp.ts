// VC-1 pixel operations with FFmpeg's integer arithmetic (vc1dsp.c, hpeldsp.c, h264chroma,
// idctdsp.c): inverse transforms, the in-loop filter and motion compensation. Planes are byte
// arrays addressed by offset; blocks are 64 int16 coefficients at an offset of a shared array.
// LGPL-2.1-or-later; copyright notices and license: ./NOTICE and ./LICENSE.

const clip = (a: number): number => (a & ~255 ? (~a >> 31) & 255 : a);

const tmp64 = new Int16Array(64);

/** In-place 8x8 inverse transform (output stays in the block). */
export function invTrans8x8(block: Int16Array, b: number): void {
  const t = tmp64;
  for (let i = 0; i < 8; i++) {
    const s = b + i;
    let t1 = 12 * (block[s]! + block[s + 32]!) + 4;
    let t2 = 12 * (block[s]! - block[s + 32]!) + 4;
    let t3 = 16 * block[s + 16]! + 6 * block[s + 48]!;
    let t4 = 6 * block[s + 16]! - 16 * block[s + 48]!;
    const t5 = t1 + t3,
      t6 = t2 + t4,
      t7 = t2 - t4,
      t8 = t1 - t3;
    const s8 = block[s + 8]!,
      s24 = block[s + 24]!,
      s40 = block[s + 40]!,
      s56 = block[s + 56]!;
    t1 = 16 * s8 + 15 * s24 + 9 * s40 + 4 * s56;
    t2 = 15 * s8 - 4 * s24 - 16 * s40 - 9 * s56;
    t3 = 9 * s8 - 16 * s24 + 4 * s40 + 15 * s56;
    t4 = 4 * s8 - 9 * s24 + 15 * s40 - 16 * s56;
    const d = i * 8;
    t[d] = (t5 + t1) >> 3;
    t[d + 1] = (t6 + t2) >> 3;
    t[d + 2] = (t7 + t3) >> 3;
    t[d + 3] = (t8 + t4) >> 3;
    t[d + 4] = (t8 - t4) >> 3;
    t[d + 5] = (t7 - t3) >> 3;
    t[d + 6] = (t6 - t2) >> 3;
    t[d + 7] = (t5 - t1) >> 3;
  }
  for (let i = 0; i < 8; i++) {
    let t1 = 12 * (t[i]! + t[i + 32]!) + 64;
    let t2 = 12 * (t[i]! - t[i + 32]!) + 64;
    let t3 = 16 * t[i + 16]! + 6 * t[i + 48]!;
    let t4 = 6 * t[i + 16]! - 16 * t[i + 48]!;
    const t5 = t1 + t3,
      t6 = t2 + t4,
      t7 = t2 - t4,
      t8 = t1 - t3;
    const s8 = t[i + 8]!,
      s24 = t[i + 24]!,
      s40 = t[i + 40]!,
      s56 = t[i + 56]!;
    t1 = 16 * s8 + 15 * s24 + 9 * s40 + 4 * s56;
    t2 = 15 * s8 - 4 * s24 - 16 * s40 - 9 * s56;
    t3 = 9 * s8 - 16 * s24 + 4 * s40 + 15 * s56;
    t4 = 4 * s8 - 9 * s24 + 15 * s40 - 16 * s56;
    const d = b + i;
    block[d] = (t5 + t1) >> 7;
    block[d + 8] = (t6 + t2) >> 7;
    block[d + 16] = (t7 + t3) >> 7;
    block[d + 24] = (t8 + t4) >> 7;
    block[d + 32] = (t8 - t4 + 1) >> 7;
    block[d + 40] = (t7 - t3 + 1) >> 7;
    block[d + 48] = (t6 - t2 + 1) >> 7;
    block[d + 56] = (t5 - t1 + 1) >> 7;
  }
}

function addDc(
  dest: Uint8Array,
  o: number,
  stride: number,
  w: number,
  h: number,
  dc: number,
): void {
  for (let y = 0; y < h; y++, o += stride)
    for (let x = 0; x < w; x++) dest[o + x] = clip(dest[o + x]! + dc);
}

export function invTrans8x8Dc(dest: Uint8Array, o: number, stride: number, dc: number): void {
  dc = (3 * dc + 1) >> 1;
  dc = (3 * dc + 16) >> 5;
  addDc(dest, o, stride, 8, 8, dc);
}

export function invTrans8x4Dc(dest: Uint8Array, o: number, stride: number, dc: number): void {
  dc = (3 * dc + 1) >> 1;
  dc = (17 * dc + 64) >> 7;
  addDc(dest, o, stride, 8, 4, dc);
}

export function invTrans4x8Dc(dest: Uint8Array, o: number, stride: number, dc: number): void {
  dc = (17 * dc + 4) >> 3;
  dc = (12 * dc + 64) >> 7;
  addDc(dest, o, stride, 4, 8, dc);
}

export function invTrans4x4Dc(dest: Uint8Array, o: number, stride: number, dc: number): void {
  dc = (17 * dc + 4) >> 3;
  dc = (17 * dc + 64) >> 7;
  addDc(dest, o, stride, 4, 4, dc);
}

/** 8 wide, 4 high: rows of `block` at `b`, added to `dest`. The first pass is in place. */
export function invTrans8x4(
  dest: Uint8Array,
  o: number,
  stride: number,
  block: Int16Array,
  b: number,
): void {
  for (let i = 0; i < 4; i++) {
    const s = b + i * 8;
    let t1 = 12 * (block[s]! + block[s + 4]!) + 4;
    let t2 = 12 * (block[s]! - block[s + 4]!) + 4;
    let t3 = 16 * block[s + 2]! + 6 * block[s + 6]!;
    let t4 = 6 * block[s + 2]! - 16 * block[s + 6]!;
    const t5 = t1 + t3,
      t6 = t2 + t4,
      t7 = t2 - t4,
      t8 = t1 - t3;
    const s1 = block[s + 1]!,
      s3 = block[s + 3]!,
      s5 = block[s + 5]!,
      s7 = block[s + 7]!;
    t1 = 16 * s1 + 15 * s3 + 9 * s5 + 4 * s7;
    t2 = 15 * s1 - 4 * s3 - 16 * s5 - 9 * s7;
    t3 = 9 * s1 - 16 * s3 + 4 * s5 + 15 * s7;
    t4 = 4 * s1 - 9 * s3 + 15 * s5 - 16 * s7;
    block[s] = (t5 + t1) >> 3;
    block[s + 1] = (t6 + t2) >> 3;
    block[s + 2] = (t7 + t3) >> 3;
    block[s + 3] = (t8 + t4) >> 3;
    block[s + 4] = (t8 - t4) >> 3;
    block[s + 5] = (t7 - t3) >> 3;
    block[s + 6] = (t6 - t2) >> 3;
    block[s + 7] = (t5 - t1) >> 3;
  }
  for (let i = 0; i < 8; i++) {
    const s = b + i,
      d = o + i;
    const t1 = 17 * (block[s]! + block[s + 16]!) + 64;
    const t2 = 17 * (block[s]! - block[s + 16]!) + 64;
    const t3 = 22 * block[s + 8]! + 10 * block[s + 24]!;
    const t4 = 22 * block[s + 24]! - 10 * block[s + 8]!;
    dest[d] = clip(dest[d]! + ((t1 + t3) >> 7));
    dest[d + stride] = clip(dest[d + stride]! + ((t2 - t4) >> 7));
    dest[d + 2 * stride] = clip(dest[d + 2 * stride]! + ((t2 + t4) >> 7));
    dest[d + 3 * stride] = clip(dest[d + 3 * stride]! + ((t1 - t3) >> 7));
  }
}

/** 4 wide, 8 high. */
export function invTrans4x8(
  dest: Uint8Array,
  o: number,
  stride: number,
  block: Int16Array,
  b: number,
): void {
  for (let i = 0; i < 8; i++) {
    const s = b + i * 8;
    const t1 = 17 * (block[s]! + block[s + 2]!) + 4;
    const t2 = 17 * (block[s]! - block[s + 2]!) + 4;
    const t3 = 22 * block[s + 1]! + 10 * block[s + 3]!;
    const t4 = 22 * block[s + 3]! - 10 * block[s + 1]!;
    block[s] = (t1 + t3) >> 3;
    block[s + 1] = (t2 - t4) >> 3;
    block[s + 2] = (t2 + t4) >> 3;
    block[s + 3] = (t1 - t3) >> 3;
  }
  for (let i = 0; i < 4; i++) {
    const s = b + i,
      d = o + i;
    let t1 = 12 * (block[s]! + block[s + 32]!) + 64;
    let t2 = 12 * (block[s]! - block[s + 32]!) + 64;
    let t3 = 16 * block[s + 16]! + 6 * block[s + 48]!;
    let t4 = 6 * block[s + 16]! - 16 * block[s + 48]!;
    const t5 = t1 + t3,
      t6 = t2 + t4,
      t7 = t2 - t4,
      t8 = t1 - t3;
    const s8 = block[s + 8]!,
      s24 = block[s + 24]!,
      s40 = block[s + 40]!,
      s56 = block[s + 56]!;
    t1 = 16 * s8 + 15 * s24 + 9 * s40 + 4 * s56;
    t2 = 15 * s8 - 4 * s24 - 16 * s40 - 9 * s56;
    t3 = 9 * s8 - 16 * s24 + 4 * s40 + 15 * s56;
    t4 = 4 * s8 - 9 * s24 + 15 * s40 - 16 * s56;
    dest[d] = clip(dest[d]! + ((t5 + t1) >> 7));
    dest[d + stride] = clip(dest[d + stride]! + ((t6 + t2) >> 7));
    dest[d + 2 * stride] = clip(dest[d + 2 * stride]! + ((t7 + t3) >> 7));
    dest[d + 3 * stride] = clip(dest[d + 3 * stride]! + ((t8 + t4) >> 7));
    dest[d + 4 * stride] = clip(dest[d + 4 * stride]! + ((t8 - t4 + 1) >> 7));
    dest[d + 5 * stride] = clip(dest[d + 5 * stride]! + ((t7 - t3 + 1) >> 7));
    dest[d + 6 * stride] = clip(dest[d + 6 * stride]! + ((t6 - t2 + 1) >> 7));
    dest[d + 7 * stride] = clip(dest[d + 7 * stride]! + ((t5 - t1 + 1) >> 7));
  }
}

/** 4x4 at `block[b]` (row stride 8). */
export function invTrans4x4(
  dest: Uint8Array,
  o: number,
  stride: number,
  block: Int16Array,
  b: number,
): void {
  for (let i = 0; i < 4; i++) {
    const s = b + i * 8;
    const t1 = 17 * (block[s]! + block[s + 2]!) + 4;
    const t2 = 17 * (block[s]! - block[s + 2]!) + 4;
    const t3 = 22 * block[s + 1]! + 10 * block[s + 3]!;
    const t4 = 22 * block[s + 3]! - 10 * block[s + 1]!;
    block[s] = (t1 + t3) >> 3;
    block[s + 1] = (t2 - t4) >> 3;
    block[s + 2] = (t2 + t4) >> 3;
    block[s + 3] = (t1 - t3) >> 3;
  }
  for (let i = 0; i < 4; i++) {
    const s = b + i,
      d = o + i;
    const t1 = 17 * (block[s]! + block[s + 16]!) + 64;
    const t2 = 17 * (block[s]! - block[s + 16]!) + 64;
    const t3 = 22 * block[s + 8]! + 10 * block[s + 24]!;
    const t4 = 22 * block[s + 24]! - 10 * block[s + 8]!;
    dest[d] = clip(dest[d]! + ((t1 + t3) >> 7));
    dest[d + stride] = clip(dest[d + stride]! + ((t2 - t4) >> 7));
    dest[d + 2 * stride] = clip(dest[d + 2 * stride]! + ((t2 + t4) >> 7));
    dest[d + 3 * stride] = clip(dest[d + 3 * stride]! + ((t1 - t3) >> 7));
  }
}

export function putPixelsClamped(
  block: Int16Array,
  b: number,
  dest: Uint8Array,
  o: number,
  stride: number,
): void {
  for (let y = 0; y < 8; y++, o += stride, b += 8)
    for (let x = 0; x < 8; x++) dest[o + x] = clip(block[b + x]!);
}

export function putSignedPixelsClamped(
  block: Int16Array,
  b: number,
  dest: Uint8Array,
  o: number,
  stride: number,
): void {
  for (let y = 0; y < 8; y++, o += stride, b += 8)
    for (let x = 0; x < 8; x++) {
      const v = block[b + x]!;
      dest[o + x] = v < -128 ? 0 : v > 127 ? 255 : v + 128;
    }
}

export function addPixelsClamped(
  block: Int16Array,
  b: number,
  dest: Uint8Array,
  o: number,
  stride: number,
): void {
  for (let y = 0; y < 8; y++, o += stride, b += 8)
    for (let x = 0; x < 8; x++) dest[o + x] = clip(dest[o + x]! + block[b + x]!);
}

function filterLine(p: Uint8Array, o: number, stride: number, pq: number): number {
  const m2 = p[o - 2 * stride]!,
    m1 = p[o - stride]!,
    p0 = p[o]!,
    p1 = p[o + stride]!;
  let a0 = (2 * (m2 - p1) - 5 * (m1 - p0) + 4) >> 3;
  const a0Sign = a0 >> 31;
  a0 = (a0 ^ a0Sign) - a0Sign;
  if (a0 < pq) {
    const a1 = Math.abs((2 * (p[o - 4 * stride]! - m1) - 5 * (p[o - 3 * stride]! - m2) + 4) >> 3);
    const a2 = Math.abs((2 * (p0 - p[o + 3 * stride]!) - 5 * (p1 - p[o + 2 * stride]!) + 4) >> 3);
    if (a1 < a0 || a2 < a0) {
      let c = m1 - p0;
      const clipSign = c >> 31;
      c = ((c ^ clipSign) - clipSign) >> 1;
      if (c) {
        const a3 = a1 < a2 ? a1 : a2;
        let d = 5 * (a3 - a0),
          dSign = d >> 31;
        d = ((d ^ dSign) - dSign) >> 3;
        dSign ^= a0Sign;
        if (!(dSign ^ clipSign)) {
          if (c < d) d = c;
          d = (d ^ dSign) - dSign;
          p[o - stride] = clip(m1 - d);
          p[o] = clip(p0 + d);
        }
        return 1;
      }
    }
  }
  return 0;
}

/** `vc1_loop_filter`: `len` pixels along an edge, `step` between them, `stride` across it. */
function loopFilter(
  p: Uint8Array,
  o: number,
  step: number,
  stride: number,
  len: number,
  pq: number,
): void {
  for (let i = 0; i < len; i += 4, o += step * 4)
    if (filterLine(p, o + 2 * step, stride, pq)) {
      filterLine(p, o, stride, pq);
      filterLine(p, o + step, stride, pq);
      filterLine(p, o + 3 * step, stride, pq);
    }
}

/** Filters the horizontal edge above row `o` (vertical filtering across it). */
export const vLoopFilter = (p: Uint8Array, o: number, stride: number, len: number, pq: number) =>
  loopFilter(p, o, 1, stride, len, pq);
/** Filters the vertical edge left of column `o`. */
export const hLoopFilter = (p: Uint8Array, o: number, stride: number, len: number, pq: number) =>
  loopFilter(p, o, stride, 1, len, pq);

const SHIFT = [0, 5, 1, 5];
const mspelTmp = new Int16Array(19 * 16);

function mspelFilter(src: Uint8Array, o: number, stride: number, mode: number, r: number): number {
  switch (mode) {
    case 1:
      return (
        (-4 * src[o - stride]! +
          53 * src[o]! +
          18 * src[o + stride]! -
          3 * src[o + 2 * stride]! +
          32 -
          r) >>
        6
      );
    case 2:
      return (
        (-1 * src[o - stride]! +
          9 * src[o]! +
          9 * src[o + stride]! -
          1 * src[o + 2 * stride]! +
          8 -
          r) >>
        4
      );
    case 3:
      return (
        (-3 * src[o - stride]! +
          18 * src[o]! +
          53 * src[o + stride]! -
          4 * src[o + 2 * stride]! +
          32 -
          r) >>
        6
      );
  }
  return src[o]!;
}

function filter16(a: number, b: number, c: number, d: number, mode: number): number {
  switch (mode) {
    case 1:
      return -4 * a + 53 * b + 18 * c - 3 * d;
    case 2:
      return -1 * a + 9 * b + 9 * c - 1 * d;
    case 3:
      return -3 * a + 18 * b + 53 * c - 4 * d;
  }
  return 0;
}

/** `vc1_mspel_mc` for an `n`x`n` block (8 or 16); `avg` averages into the destination. */
export function mspelMc(
  dst: Uint8Array,
  d: number,
  src: Uint8Array,
  s: number,
  stride: number,
  n: number,
  hmode: number,
  vmode: number,
  rnd: number,
  avg: boolean,
): void {
  if (!hmode && !vmode) {
    for (let j = 0; j < n; j++, d += stride, s += stride)
      for (let i = 0; i < n; i++)
        dst[d + i] = avg ? (dst[d + i]! + src[s + i]! + 1) >> 1 : src[s + i]!;
    return;
  }
  if (vmode) {
    if (hmode) {
      const shift = (SHIFT[hmode]! + SHIFT[vmode]!) >> 1,
        w = n + 3,
        t = mspelTmp;
      let r = (1 << (shift - 1)) + rnd - 1;
      s -= 1;
      for (let j = 0, tp = 0; j < n; j++, s += stride, tp += w)
        for (let i = 0; i < w; i++) {
          const o = s + i;
          t[tp + i] =
            (filter16(src[o - stride]!, src[o]!, src[o + stride]!, src[o + 2 * stride]!, vmode) +
              r) >>
            shift;
        }
      r = 64 - rnd;
      for (let j = 0, tp = 1; j < n; j++, d += stride, tp += w)
        for (let i = 0; i < n; i++) {
          const o = tp + i;
          const v = clip((filter16(t[o - 1]!, t[o]!, t[o + 1]!, t[o + 2]!, hmode) + r) >> 7);
          dst[d + i] = avg ? (dst[d + i]! + v + 1) >> 1 : v;
        }
      return;
    }
    const r = 1 - rnd;
    for (let j = 0; j < n; j++, s += stride, d += stride)
      for (let i = 0; i < n; i++) {
        const v = clip(mspelFilter(src, s + i, stride, vmode, r));
        dst[d + i] = avg ? (dst[d + i]! + v + 1) >> 1 : v;
      }
    return;
  }
  for (let j = 0; j < n; j++, d += stride, s += stride)
    for (let i = 0; i < n; i++) {
      const v = clip(mspelFilter(src, s + i, 1, hmode, rnd));
      dst[d + i] = avg ? (dst[d + i]! + v + 1) >> 1 : v;
    }
}

/** hpeldsp half-pel MC for an `n`x`n` block, `dxy` = x half (bit 0) | y half (bit 1); the
 * `no_rnd` variants round down, `avg` averages into the destination (rounding up). */
export function hpelMc(
  dst: Uint8Array,
  d: number,
  src: Uint8Array,
  s: number,
  stride: number,
  n: number,
  dxy: number,
  noRnd: boolean,
  avg: boolean,
): void {
  const r2 = noRnd ? 0 : 1,
    r4 = noRnd ? 1 : 2;
  for (let j = 0; j < n; j++, d += stride, s += stride)
    for (let i = 0; i < n; i++) {
      const o = s + i;
      let v: number;
      switch (dxy) {
        case 0:
          v = src[o]!;
          break;
        case 1:
          v = (src[o]! + src[o + 1]! + r2) >> 1;
          break;
        case 2:
          v = (src[o]! + src[o + stride]! + r2) >> 1;
          break;
        default:
          v = (src[o]! + src[o + 1]! + src[o + stride]! + src[o + stride + 1]! + r4) >> 2;
      }
      dst[d + i] = avg ? (dst[d + i]! + v + 1) >> 1 : v;
    }
}

/** Bilinear chroma MC, `w` wide and `h` high, eighth-pel `x`/`y`: H.264 rounding (+32) or
 * the VC-1 no-rounding variant (+28); `avg` averages into the destination. */
export function chromaMc(
  dst: Uint8Array,
  d: number,
  src: Uint8Array,
  s: number,
  stride: number,
  w: number,
  h: number,
  x: number,
  y: number,
  noRnd: boolean,
  avg: boolean,
): void {
  const A = (8 - x) * (8 - y),
    B = x * (8 - y),
    C = (8 - x) * y,
    D = x * y,
    r = noRnd ? 28 : 32;
  for (let j = 0; j < h; j++, d += stride, s += stride)
    for (let i = 0; i < w; i++) {
      const o = s + i;
      const v =
        (A * src[o]! + B * src[o + 1]! + C * src[o + stride]! + D * src[o + stride + 1]! + r) >> 6;
      dst[d + i] = avg ? (dst[d + i]! + v + 1) >> 1 : v;
    }
}
