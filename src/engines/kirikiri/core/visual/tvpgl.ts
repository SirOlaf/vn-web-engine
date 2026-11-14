/**
 * Pixel kernels of the TVP graphics library as the reference build runs them. The core picks
 * each kernel at start-up (`TVPGL_C_Init`, then `TVPGL_IA32_Init` by CPU features); on a CPU
 * with MMX, EMMX (SSE) and SSE2 the reference build uses the kirikiri 2 MMX assembly for the
 * kernels marked `asm` below and the generated C (`tvpgl.c` of kirikiri 2) for the others.
 * The assembly differs from the C (and from the later krkrz functors) in rounding, in how it
 * treats the alpha channel, and in shortcuts for opaque or transparent pixel pairs, so each
 * kernel follows its own code path, including the order in which pixels are taken singly or
 * in pairs. Verified against the reference build's code under an x86 emulator.
 *
 * Pixels are 32-bit `0xAARRGGBB` words in little-endian memory, addressed as element indexes
 * into a `Uint32Array` over the core memory (`memory.ts`); an index's parity is the pixel's
 * 8-byte alignment, which the assembly tests. C `tjs_uint32` arithmetic wraps modulo 2^32:
 * products go through `Math.imul` and shifts of unsigned values use `>>>`.
 */

/** `TVPOpacityOnOpacityTable`, `TVPNegativeMulTable`, `TVPDivTable`, `TVPRecipTable256`. */
export interface TvpglTables {
  readonly opacityOnOpacity: Uint8Array;
  readonly negativeMul: Uint8Array;
  readonly div: Uint8Array;
  readonly recip256: Uint32Array;
}

let tables: TvpglTables | null = null;

/** `TVPCreateTable` (single-precision arithmetic as the SSE2 build computes it). */
export function tvpglTables(): TvpglTables {
  if (tables) return tables;
  const f = Math.fround;
  const opacityOnOpacity = new Uint8Array(256 * 256);
  const negativeMul = new Uint8Array(256 * 256);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const addr = b * 256 + a;
      let ci: number;
      if (a) {
        const at = f(a / 255.0),
          bt = f(b / 255.0);
        let c = f(bt / at);
        c = f(c / f(1.0 - bt + c));
        ci = Math.trunc(f(c * 255));
        if (ci >= 256) ci = 255;
      } else ci = 255;
      opacityOnOpacity[addr] = ci;
      negativeMul[addr] = 255 - Math.trunc(((255 - a) * (255 - b)) / 255);
    }
  }
  const div = new Uint8Array(256 * 256);
  for (let b = 0; b < 256; b++) {
    div[b] = 0;
    for (let a = 1; a < 256; a++) div[(a << 8) + b] = Math.min(255, Math.trunc((b * 255) / a));
  }
  const recip256 = new Uint32Array(256);
  recip256[0] = 65536;
  for (let i = 1; i < 256; i++) recip256[i] = Math.trunc(65536 / i);
  tables = {opacityOnOpacity, negativeMul, div, recip256};
  return tables;
}

// --- MMX lane arithmetic -----------------------------------------------------------------------
// The assembly unpacks the four bytes of a pixel into 16-bit words, works on them and packs
// them back with unsigned saturation.

/** `psllw 8; paddw (s−d)·a; psrlw 8`: `(d·256 + (s−d)·a) mod 65536 / 256` per byte. */
function blendW(d: number, s: number, a: number): number {
  let r = 0;
  for (let sh = 0; sh < 32; sh += 8) {
    const dc = (d >>> sh) & 0xff,
      sc = (s >>> sh) & 0xff;
    r |= ((((dc << 8) + (sc - dc) * a) & 0xffff) >>> 8) << sh;
  }
  return r >>> 0;
}

/** `psubw; pmullw a; psrlw 8; paddb`: `d + ((s−d)·a mod 65536)/256` per byte, wrapping. */
function blendB(d: number, s: number, a: number): number {
  let r = 0;
  for (let sh = 0; sh < 32; sh += 8) {
    const dc = (d >>> sh) & 0xff,
      sc = (s >>> sh) & 0xff;
    r |= ((dc + ((((sc - dc) * a) & 0xffff) >>> 8)) & 0xff) << sh;
  }
  return r >>> 0;
}

/** `paddusb`: bytewise saturated addition. */
function addUSB(a: number, b: number): number {
  let r = 0;
  for (let sh = 0; sh < 32; sh += 8)
    r |= Math.min(255, ((a >>> sh) & 0xff) + ((b >>> sh) & 0xff)) << sh;
  return r >>> 0;
}

/** `d − (d·a)/256` per byte (`pmullw; psrlw 8; psubw`), then `+ s` saturating (`paddusb`). */
function premulOver(d: number, s: number, a: number): number {
  let t = 0;
  for (let sh = 0; sh < 32; sh += 8) {
    const dc = (d >>> sh) & 0xff;
    t |= (dc - ((dc * a) >>> 8)) << sh;
  }
  return addUSB(t >>> 0, s);
}

/** `d − (d·a)/256 + s` per byte in words (`paddw`), packed with saturation. */
function premulOverW(d: number, s: number, a: number): number {
  let r = 0;
  for (let sh = 0; sh < 32; sh += 8) {
    const dc = (d >>> sh) & 0xff;
    r |= Math.min(255, dc - ((dc * a) >>> 8) + ((s >>> sh) & 0xff)) << sh;
  }
  return r >>> 0;
}

type LineKernel = (m: Uint32Array, dest: number, src: number, len: number, opa: number) => void;

// --- C functors of the generated kirikiri 2 tvpgl.c ----------------------------------------

/** `TVPAddAlphaBlend_a_a`: premultiplied onto premultiplied. */
function addAlphaAA(d: number, s: number): number {
  let da = d >>> 24;
  let sa = s >>> 24;
  da = da + sa - ((da * sa) >>> 8);
  da -= da >>> 8;
  sa ^= 0xff;
  const c =
    ((Math.imul(d & 0xff00ff, sa) >>> 8) & 0xff00ff) + ((Math.imul(d & 0xff00, sa) >>> 8) & 0xff00);
  return ((da << 24) + satAdd(c >>> 0, s & 0xffffff)) >>> 0;
}

/** Bytewise saturated addition of the C code. */
function satAdd(a: number, b: number): number {
  let tmp = ((a & b) + (((a ^ b) >>> 1) & 0x7f7f7f7f)) & 0x80808080;
  tmp = ((tmp << 1) - (tmp >>> 7)) | 0;
  return ((a + b - tmp) | 0 | tmp) >>> 0;
}

/** Colour channels times `fac / 256`, alpha kept. */
function toPremul(s: number, fac: number): number {
  return (
    (((((Math.imul(s & 0xff00ff, fac) & 0xff00ff00) >>> 0) +
      ((Math.imul(s & 0xff00, fac) & 0xff0000) >>> 0)) >>>
      8) +
      (s & 0xff000000)) >>>
    0
  );
}

/** `d + (s − d)·a/256` per colour channel; alpha `alpha`. The C alpha blend. */
function blendC(d: number, s: number, a: number, alpha: number): number {
  const d1 = d & 0xff00ff;
  const c1 = (d1 + (Math.imul((s & 0xff00ff) - d1, a) >>> 8)) & 0xff00ff;
  const d2 = d & 0xff00;
  const c2 = (d2 + (Math.imul((s & 0xff00) - d2, a) >>> 8)) & 0xff00;
  return (c1 + c2 + alpha) >>> 0;
}

// --- alpha blends ----------------------------------------------------------------------------

/** `TVPAlphaBlend` (asm 0x61dbe0). */
export const TVPAlphaBlend: LineKernel = (m, dest, src, len) => {
  if (len <= 0) return;
  const one = (i: number, j: number) => {
    const s = m[j]!;
    if (s >= 0xff000000) m[i] = s;
    else m[i] = blendB(m[i]!, s, s >>> 24);
  };
  let i = dest,
    j = src;
  const end = dest + len;
  const limit = end - 4;
  if (i < limit) {
    if (i & 1) {
      one(i++, j++);
    }
    while (i < limit) {
      const s0 = m[j]!,
        s1 = m[j + 1]!;
      if ((s0 & s1) >>> 0 >= 0xff000000) {
        m[i] = s0;
        m[i + 1] = s1;
      } else if ((s0 | s1) >>> 0 > 0xffffff) {
        m[i] = blendB(m[i]!, s0, s0 >>> 24);
        m[i + 1] = blendB(m[i + 1]!, s1, s1 >>> 24);
      }
      i += 2;
      j += 2;
    }
  }
  while (i < end) one(i++, j++);
};

/** `TVPAlphaBlend_o` (asm 0x61dd64). */
export const TVPAlphaBlend_o: LineKernel = (m, dest, src, len, opa) => {
  if (len <= 0) return;
  const one = (i: number, j: number) => {
    const s = m[j]!;
    // `mul`: the high doubleword of s · opa.
    m[i] = blendW(m[i]!, s, Math.floor((s * opa) / 4294967296));
  };
  let i = dest,
    j = src;
  const end = dest + len;
  const limit = end - 2;
  if (i < limit) {
    if (i & 1) one(i++, j++);
    while (i < limit) {
      const s0 = m[j]!,
        s1 = m[j + 1]!;
      if (((s0 | s1) & 0xff000000) !== 0) {
        m[i] = blendB(m[i]!, s0, (((s0 >>> 24) * opa) & 0xffff) >>> 8);
        m[i + 1] = blendB(m[i + 1]!, s1, (((s1 >>> 24) * opa) & 0xffff) >>> 8);
      }
      i += 2;
      j += 2;
    }
  }
  while (i < end) one(i++, j++);
};

/** `TVPAlphaBlend_HDA` (asm 0x61dec8): from the last pixel to the first. */
export const TVPAlphaBlend_HDA: LineKernel = (m, dest, src, len) => {
  for (let k = len - 1; k >= 0; k--) {
    const d = m[dest + k]!,
      s = m[src + k]!;
    m[dest + k] = ((blendW(d, s, s >>> 24) & 0xffffff) | (d & 0xff000000)) >>> 0;
  }
};

/** `TVPAlphaBlend_HDA_o` (C 0x537f80). */
export const TVPAlphaBlend_HDA_o: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!,
      s = m[src + k]!;
    const a = Math.imul(s >>> 24, opa) >>> 8;
    m[dest + k] = blendC(d, s, a, d & 0xff000000);
  }
};

/** `TVPAlphaBlend_d` (asm 0x61df40). */
export const TVPAlphaBlend_d: LineKernel = (m, dest, src, len) => {
  if (len <= 0) return;
  const {opacityOnOpacity, negativeMul} = tvpglTables();
  let i = dest,
    j = src;
  const end = dest + len;
  const limit = end - 1;
  const pairOne = (k: number, s: number) => {
    const d = m[k]!;
    const addr = ((s >>> 16) & 0xff00) + (d >>> 24);
    const color = blendW(d & 0xffffff, s & 0xffffff, opacityOnOpacity[addr]!);
    const t = addr ^ 0xffff;
    const prod = Math.imul(t & 0xff, t >>> 8);
    m[k] = (color | ((~prod & 0xff00) << 16)) >>> 0;
  };
  while (i < limit) {
    const s0 = m[j]!,
      s1 = m[j + 1]!;
    if ((s0 & s1) >>> 0 >= 0xff000000) {
      m[i] = s0;
      m[i + 1] = s1;
    } else if ((s0 | s1) >>> 0 > 0xffffff) {
      pairOne(i, s0);
      pairOne(i + 1, s1);
    }
    i += 2;
    j += 2;
  }
  while (i < end) {
    const d = m[i]!,
      s = m[j]!;
    const addr = ((s >>> 16) & 0xff00) + (d >>> 24);
    m[i] =
      (blendW(d & 0xffffff, s & 0xffffff, opacityOnOpacity[addr]!) | (negativeMul[addr]! << 24)) >>>
      0;
    i++;
    j++;
  }
};

/** `TVPAlphaBlend_do` (C 0x538600). */
export const TVPAlphaBlend_do: LineKernel = (m, dest, src, len, opa) => {
  const {opacityOnOpacity, negativeMul} = tvpglTables();
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!,
      s = m[src + k]!;
    const addr = (Math.imul(s >>> 24, opa) & 0xff00) + (d >>> 24);
    m[dest + k] = blendC(d, s, opacityOnOpacity[addr]!, (negativeMul[addr]! << 24) >>> 0);
  }
};

/** `TVPAlphaBlend_a` (C 0x538420): a straight-alpha source onto a premultiplied destination. */
export const TVPAlphaBlend_a: LineKernel = (m, dest, src, len) => {
  for (let k = 0; k < len; k++) {
    const s = m[src + k]!;
    m[dest + k] = addAlphaAA(m[dest + k]!, toPremul(s, s >>> 24));
  }
};

/** `TVPAlphaBlend_ao` (C 0x5388a0). */
export const TVPAlphaBlend_ao: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) {
    let s = m[src + k]!;
    s = ((s & 0xffffff) + ((Math.imul(s >>> 24, opa) >>> 8) << 24)) >>> 0;
    m[dest + k] = addAlphaAA(m[dest + k]!, toPremul(s, s >>> 24));
  }
};

// --- premultiplied (additive) alpha blends ---------------------------------------------------

/** `TVPAdditiveAlphaBlend` (asm 0x620a50). */
export const TVPAdditiveAlphaBlend: LineKernel = (m, dest, src, len) => {
  if (len <= 0) return;
  const one = (i: number, s: number) => {
    m[i] = premulOver(m[i]!, s, s >>> 24);
  };
  let i = dest,
    j = src;
  const end = dest + len;
  const limit = end - 2;
  if (i < limit) {
    if (i & 1) one(i++, m[j++]!);
    while (i < limit) {
      const s0 = m[j]!,
        s1 = m[j + 1]!;
      if ((s0 | s1) !== 0) {
        if ((s0 & s1) >>> 0 >= 0xff000000) {
          m[i] = s0;
          m[i + 1] = s1;
        } else {
          one(i, s0);
          one(i + 1, s1);
        }
      }
      i += 2;
      j += 2;
    }
  }
  while (i < end) one(i++, m[j++]!);
};

/** `TVPAdditiveAlphaBlend_o` (asm 0x620ba0). */
export const TVPAdditiveAlphaBlend_o: LineKernel = (m, dest, src, len, opa) => {
  const o = opa + (opa >>> 7);
  for (let k = 0; k < len; k++) {
    const s = m[src + k]!;
    let ss = 0;
    for (let sh = 0; sh < 32; sh += 8) ss |= ((((s >>> sh) & 0xff) * o) >>> 8) << sh;
    ss >>>= 0;
    m[dest + k] = premulOverW(m[dest + k]!, ss, ss >>> 24);
  }
};

/** `TVPAdditiveAlphaBlend_HDA` (asm 0x620cfc): destination alpha kept. */
export const TVPAdditiveAlphaBlend_HDA: LineKernel = (m, dest, src, len) => {
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!,
      s = m[src + k]!;
    const a = s >>> 24;
    let t = 0;
    for (let sh = 0; sh < 24; sh += 8) {
      const dc = (d >>> sh) & 0xff;
      t |= (dc - ((dc * a) >>> 8)) << sh;
    }
    t = (t | (d & 0xff000000)) >>> 0;
    m[dest + k] = addUSB(t, s & 0xffffff);
  }
};

/** `TVPAdditiveAlphaBlend_HDA_o` (C 0x539a60). */
export const TVPAdditiveAlphaBlend_HDA_o: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!;
    let s = m[src + k]!;
    s =
      (((Math.imul(s & 0xff00ff, opa) >>> 8) & 0xff00ff) +
        (Math.imul((s >>> 8) & 0xff00ff, opa) & 0xff00ff00)) >>>
      0;
    const sopa = ~s >>> 24;
    const c =
      ((Math.imul(d & 0xff00ff, sopa) >>> 8) & 0xff00ff) +
      ((Math.imul(d & 0xff00, sopa) >>> 8) & 0xff00);
    m[dest + k] = ((satAdd(c >>> 0, s) & 0xffffff) | (d & 0xff000000)) >>> 0;
  }
};

/** `TVPAdditiveAlphaBlend_a` (asm 0x620e0c). */
export const TVPAdditiveAlphaBlend_a: LineKernel = (m, dest, src, len) => {
  if (len <= 0) return;
  const one = (i: number, s: number) => {
    m[i] = premulOverW(m[i]!, s, s >>> 24);
  };
  let i = dest,
    j = src;
  const end = dest + len;
  const limit = end - 2;
  if (i < limit) {
    if (i & 1) one(i++, m[j++]!);
    while (i < limit) {
      const s0 = m[j]!,
        s1 = m[j + 1]!;
      if ((s0 | s1) !== 0) {
        if ((s0 & s1) >>> 0 >= 0xff000000) {
          m[i] = s0;
          m[i + 1] = s1;
        } else {
          one(i, s0);
          one(i + 1, s1);
        }
      }
      i += 2;
      j += 2;
    }
  }
  while (i < end) one(i++, m[j++]!);
};

/** `TVPAdditiveAlphaBlend_ao` (C 0x53a130). */
export const TVPAdditiveAlphaBlend_ao: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) {
    let s = m[src + k]!;
    s =
      (((Math.imul(s & 0xff00ff, opa) >>> 8) & 0xff00ff) +
        (Math.imul((s >>> 8) & 0xff00ff, opa) & 0xff00ff00)) >>>
      0;
    m[dest + k] = addAlphaAA(m[dest + k]!, s);
  }
};

// --- constant-ratio blends -------------------------------------------------------------------

/** `TVPConstAlphaBlend` (asm 0x61e114): every byte, alpha included. */
export const TVPConstAlphaBlend: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) m[dest + k] = blendW(m[dest + k]!, m[src + k]!, opa);
};

/** `TVPConstAlphaBlend_HDA` (C 0x540330). */
export const TVPConstAlphaBlend_HDA: LineKernel = (m, dest, src, len, opa) => {
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!;
    m[dest + k] = blendC(d, m[src + k]!, opa, d & 0xff000000);
  }
};

/** `TVPConstAlphaBlend_d` (C 0x540510). */
export const TVPConstAlphaBlend_d: LineKernel = (m, dest, src, len, opa) => {
  const {opacityOnOpacity, negativeMul} = tvpglTables();
  const o = opa << 8;
  for (let k = 0; k < len; k++) {
    const d = m[dest + k]!;
    const addr = (d >>> 24) + o;
    m[dest + k] = blendC(d, m[src + k]!, opacityOnOpacity[addr]!, (negativeMul[addr]! << 24) >>> 0);
  }
};

/** `TVPConstAlphaBlend_a` (C 0x540770). */
export const TVPConstAlphaBlend_a: LineKernel = (m, dest, src, len, opa) => {
  const o = (opa << 24) >>> 0;
  for (let k = 0; k < len; k++)
    m[dest + k] = addAlphaAA(m[dest + k]!, ((m[src + k]! & 0xffffff) | o) >>> 0);
};

// --- copies and fills ------------------------------------------------------------------------

/** `TVPCopyColor` (C): colour from the source, alpha kept. */
export function copyColor(m: Uint32Array, dest: number, src: number, len: number): void {
  for (let k = 0; k < len; k++)
    m[dest + k] = ((m[dest + k]! & 0xff000000) + (m[src + k]! & 0x00ffffff)) >>> 0;
}

/** `TVPCopyMask` (C): alpha from the source, colour kept. */
export function copyMask(m: Uint32Array, dest: number, src: number, len: number): void {
  for (let k = 0; k < len; k++)
    m[dest + k] = ((m[src + k]! & 0xff000000) + (m[dest + k]! & 0x00ffffff)) >>> 0;
}

/** `TVPCopyOpaqueImage` (C): the source with alpha 255. */
export function copyOpaqueImage(m: Uint32Array, dest: number, src: number, len: number): void {
  for (let k = 0; k < len; k++) m[dest + k] = (0xff000000 | m[src + k]!) >>> 0;
}

/** `TVPFillARGB` (asm). */
export function fillARGB(m: Uint32Array, dest: number, len: number, value: number): void {
  if (len > 0) m.fill(value >>> 0, dest, dest + len);
}

/** `TVPFillColor` (asm): colour only, alpha kept. */
export function fillColor(m: Uint32Array, dest: number, len: number, color: number): void {
  const c = color & 0xffffff;
  for (let i = dest, e = dest + len; i < e; i++) m[i] = ((m[i]! & 0xff000000) | c) >>> 0;
}

/** `TVPFillMask` (C): alpha only, colour kept. */
export function fillMask(m: Uint32Array, dest: number, len: number, mask: number): void {
  const a = (mask << 24) >>> 0;
  for (let i = dest, e = dest + len; i < e; i++) m[i] = ((m[i]! & 0x00ffffff) + a) >>> 0;
}

/** `TVPConstColorAlphaBlend` (asm 0x6218e0): colour blended at a constant opacity, alpha kept. */
export function constColorAlphaBlend(
  m: Uint32Array,
  dest: number,
  len: number,
  color: number,
  opa: number,
): void {
  const iopa = ~opa & 0xff;
  for (let i = dest, e = dest + len; i < e; i++) {
    const d = m[i]!;
    let r = 0;
    for (let sh = 0; sh < 24; sh += 8) {
      const w = Math.min(
        0xffff,
        ((d >>> sh) & 0xff) * iopa + ((((color >>> sh) & 0xff) * opa) & 0xffff),
      );
      r |= (w >>> 8) << sh;
    }
    m[i] = ((r & 0xffffff) | (d & 0xff000000)) >>> 0;
  }
}

/** `TVPConstColorAlphaBlend_d` (asm 0x6219f4): on a destination with alpha. */
export function constColorAlphaBlendD(
  m: Uint32Array,
  dest: number,
  len: number,
  color: number,
  opa: number,
): void {
  const {opacityOnOpacity, negativeMul} = tvpglTables();
  const c = color & 0xffffff;
  const o = opa << 8;
  for (let i = dest, e = dest + len; i < e; i++) {
    const d = m[i]!;
    const addr = o + (d >>> 24);
    m[i] = (blendW(d & 0xffffff, c, opacityOnOpacity[addr]!) | (negativeMul[addr]! << 24)) >>> 0;
  }
}

/** `TVPConstColorAlphaBlend_a` (asm 0x621b40): on a premultiplied destination. */
export function constColorAlphaBlendA(
  m: Uint32Array,
  dest: number,
  len: number,
  color: number,
  opa: number,
): void {
  const o = opa + (opa >>> 7);
  // The colour scaled by o; the alpha byte is o's low byte (0 at full opacity, as natively).
  let s = (o & 0xff) << 24;
  for (let sh = 0; sh < 24; sh += 8) s |= ((((color >>> sh) & 0xff) * o) >>> 8) << sh;
  s >>>= 0;
  for (let i = dest, e = dest + len; i < e; i++) {
    const d = m[i]!;
    let r = 0;
    for (let sh = 0; sh < 32; sh += 8) {
      const dc = (d >>> sh) & 0xff;
      r |= Math.min(255, dc - ((dc * o) >>> 8) + ((s >>> sh) & 0xff)) << sh;
    }
    m[i] = r >>> 0;
  }
}

/** `TVPRemoveConstOpacity` (C). */
export function removeConstOpacity(m: Uint32Array, dest: number, len: number, level: number): void {
  const strength = 255 - level;
  for (let i = dest, e = dest + len; i < e; i++) {
    const d = m[i]!;
    m[i] = ((d & 0xffffff) + ((((d >>> 24) * strength) << 16) & 0xff000000)) >>> 0;
  }
}

/** `TVPConvertAlphaToAdditiveAlpha` (C). */
export function convertAlphaToAddAlpha(m: Uint32Array, dest: number, len: number): void {
  for (let i = dest, e = dest + len; i < e; i++) {
    const d = m[i]!;
    m[i] = toPremul(d, d >>> 24);
  }
}

/** `TVPConvertAdditiveAlphaToAlpha` (C). */
export function convertAddAlphaToAlpha(m: Uint32Array, dest: number, len: number): void {
  const {div} = tvpglTables();
  for (let i = dest, e = dest + len; i < e; i++) {
    const tmp = m[i]!;
    const t = (tmp >>> 16) & 0xff00;
    m[i] =
      ((tmp & 0xff000000) +
        (div[t + ((tmp >>> 16) & 0xff)]! << 16) +
        (div[t + ((tmp >>> 8) & 0xff)]! << 8) +
        div[t + (tmp & 0xff)]!) >>>
      0;
  }
}

/** `TVPDoGrayScale` (C). */
export function doGrayScale(m: Uint32Array, dest: number, len: number): void {
  for (let i = dest, e = dest + len; i < e; i++) {
    const s1 = m[i]!;
    let d1 = (s1 & 0xff) * 19;
    d1 += ((s1 >>> 8) & 0xff) * 183;
    d1 += ((s1 >>> 16) & 0xff) * 54;
    m[i] = ((d1 >>> 8) * 0x10101 + (s1 & 0xff000000)) >>> 0;
  }
}

/** `TVPSwapLine32`: exchanges two lines. */
export function swapLine32(m: Uint32Array, l1: number, l2: number, len: number): void {
  for (let i = 0; i < len; i++) {
    const t = m[l1 + i]!;
    m[l1 + i] = m[l2 + i]!;
    m[l2 + i] = t;
  }
}

/** `TVPSwapLine8`. */
export function swapLine8(m: Uint8Array, l1: number, l2: number, len: number): void {
  for (let i = 0; i < len; i++) {
    const t = m[l1 + i]!;
    m[l1 + i] = m[l2 + i]!;
    m[l2 + i] = t;
  }
}

/** `TVPReverse32`: reverses a line. */
export function reverse32(m: Uint32Array, line: number, len: number): void {
  for (let a = line, b = line + len - 1; a < b; a++, b--) {
    const t = m[a]!;
    m[a] = m[b]!;
    m[b] = t;
  }
}

/** `TVPReverse8`. */
export function reverse8(m: Uint8Array, line: number, len: number): void {
  for (let a = line, b = line + len - 1; a < b; a++, b--) {
    const t = m[a]!;
    m[a] = m[b]!;
    m[b] = t;
  }
}

/** The kernels by exporter name, with their reference build addresses, for verification. */
export const TVPGL_KERNELS: Readonly<
  Record<string, {readonly address: number; readonly run: LineKernel}>
> = {
  TVPAlphaBlend: {address: 0x61dbe0, run: TVPAlphaBlend},
  TVPAlphaBlend_o: {address: 0x61dd64, run: TVPAlphaBlend_o},
  TVPAlphaBlend_HDA: {address: 0x61dec8, run: TVPAlphaBlend_HDA},
  TVPAlphaBlend_HDA_o: {address: 0x537f80, run: TVPAlphaBlend_HDA_o},
  TVPAlphaBlend_d: {address: 0x61df40, run: TVPAlphaBlend_d},
  TVPAlphaBlend_do: {address: 0x538600, run: TVPAlphaBlend_do},
  TVPAlphaBlend_a: {address: 0x538420, run: TVPAlphaBlend_a},
  TVPAlphaBlend_ao: {address: 0x5388a0, run: TVPAlphaBlend_ao},
  TVPAdditiveAlphaBlend: {address: 0x620a50, run: TVPAdditiveAlphaBlend},
  TVPAdditiveAlphaBlend_o: {address: 0x620ba0, run: TVPAdditiveAlphaBlend_o},
  TVPAdditiveAlphaBlend_HDA: {address: 0x620cfc, run: TVPAdditiveAlphaBlend_HDA},
  TVPAdditiveAlphaBlend_HDA_o: {address: 0x539a60, run: TVPAdditiveAlphaBlend_HDA_o},
  TVPAdditiveAlphaBlend_a: {address: 0x620e0c, run: TVPAdditiveAlphaBlend_a},
  TVPAdditiveAlphaBlend_ao: {address: 0x53a130, run: TVPAdditiveAlphaBlend_ao},
  TVPConstAlphaBlend: {address: 0x61e114, run: TVPConstAlphaBlend},
  TVPConstAlphaBlend_HDA: {address: 0x540330, run: TVPConstAlphaBlend_HDA},
  TVPConstAlphaBlend_d: {address: 0x540510, run: TVPConstAlphaBlend_d},
  TVPConstAlphaBlend_a: {address: 0x540770, run: TVPConstAlphaBlend_a},
  TVPCopyColor: {address: 0x54c8a0, run: (m, d, s, n) => copyColor(m, d, s, n)},
  TVPCopyMask: {address: 0x54c5d0, run: (m, d, s, n) => copyMask(m, d, s, n)},
  TVPCopyOpaqueImage: {address: 0x540020, run: (m, d, s, n) => copyOpaqueImage(m, d, s, n)},
};

type FillKernel = (m: Uint32Array, dest: number, len: number, value: number, opa: number) => void;

/** The line kernels with a constant value, by exporter name, for verification. */
export const TVPGL_FILL_KERNELS: Readonly<
  Record<string, {readonly address: number; readonly run: FillKernel}>
> = {
  TVPFillARGB: {address: 0x6216f4, run: (m, d, n, v) => fillARGB(m, d, n, v)},
  TVPFillColor: {address: 0x6217d4, run: (m, d, n, v) => fillColor(m, d, n, v)},
  TVPFillMask: {address: 0x54cde0, run: (m, d, n, v) => fillMask(m, d, n, v)},
  TVPConstColorAlphaBlend: {address: 0x6218e0, run: constColorAlphaBlend},
  TVPConstColorAlphaBlend_d: {address: 0x6219f4, run: constColorAlphaBlendD},
  TVPConstColorAlphaBlend_a: {address: 0x621b40, run: constColorAlphaBlendA},
  TVPRemoveConstOpacity: {
    address: 0x547030,
    run: (m, d, n, v) => removeConstOpacity(m, d, n, v & 0xff),
  },
  TVPDoGrayScale: {address: 0x54eaf0, run: (m, d, n) => doGrayScale(m, d, n)},
  TVPConvertAlphaToAdditiveAlpha: {
    address: 0x53a490,
    run: (m, d, n) => convertAlphaToAddAlpha(m, d, n),
  },
  TVPConvertAdditiveAlphaToAlpha: {
    address: 0x53a2f0,
    run: (m, d, n) => convertAddAlphaToAlpha(m, d, n),
  },
};
