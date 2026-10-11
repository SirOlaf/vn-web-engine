/**
 * The runtime's uniform random source: one xorshift128 generator shared by every player
 * of the module (global 0x100875ec, created by 0x1000d5e0). The first three words are the
 * classic Marsaglia seeds; the fourth is `_time64(NULL)` at first use.
 */
export class EmoteXorshift128 {
  private x = 123456789;
  private y = 362436069;
  private z = 521288629;
  private w: number;

  constructor(seed: number = Math.floor(Date.now() / 1000)) {
    this.w = seed >>> 0;
  }

  /**
   * Next 32-bit word (0x10005190 body, inlined in 0x1000d780). The native update is
   * `w' = (((w >> 11) ^ t) >> 8) ^ w ^ t` with `t = x ^ (x << 11)`, which differs from
   * Marsaglia's `w ^ (w >> 19) ^ t ^ (t >> 8)`; the native form is kept.
   */
  nextWord(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    const w = this.w;
    this.x = this.y;
    this.y = this.z;
    this.z = w;
    this.w = ((((w >>> 11) ^ t) >>> 8) ^ w ^ t) >>> 0;
    return this.w;
  }

  /**
   * Uniform value in [0, 1) (0x10005190): the low 23 bits as the mantissa of a float in
   * [1, 2), minus 1. Exact in both float and double.
   */
  next(): number {
    return (this.nextWord() & 0x7fffff) / 0x800000;
  }
}
