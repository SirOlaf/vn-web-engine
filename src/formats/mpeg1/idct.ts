// Separable orthonormal inverse DCT. Float64 intermediates avoid intermediate rounding drift.
const BASIS = Float64Array.from({length: 64}, (_, i) => {
  const x = i >> 3,
    u = i & 7;
  return (u ? 0.5 : Math.SQRT1_2 * 0.5) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});
/** Entry `u * 8 + x`: the basis of frequency `u` at sample `x`. */
export const BASIS_BY_FREQUENCY = Float64Array.from(
  {length: 64},
  (_, i) => BASIS[(i & 7) * 8 + (i >> 3)]!,
);
/** Zero coefficients contribute exact zeros, so skipping them keeps every nonzero sum
 * bit-identical: the remaining products are added in the same order. */
export class MpegIdct {
  private readonly temp = new Float64Array(64);
  private readonly columns = new Uint8Array(8);
  private readonly sums = new Float64Array(64);
  add(coeff: Int32Array, dest: Uint8Array, offset: number, stride: number, intra: boolean): void {
    const t = this.temp,
      columns = this.columns;
    let count = 0,
      dcOnly = true;
    for (let u = 0; u < 8; u++) {
      let last = 0;
      for (let v = 7; v > 0; v--)
        if (coeff[v * 8 + u]) {
          last = v;
          break;
        }
      if (last === 0) {
        const c = coeff[u]!;
        if (!c) continue;
        const dc = c * BASIS[0]!;
        for (let y = 0; y < 8; y++) t[y * 8 + u] = dc;
      } else
        for (let y = 0; y < 8; y++) {
          let sum = 0;
          for (let v = 0; v <= last; v++) {
            const c = coeff[v * 8 + u]!;
            if (c) sum += c * BASIS[y * 8 + v]!;
          }
          t[y * 8 + u] = sum;
        }
      if (u || last) dcOnly = false;
      columns[count++] = u;
    }
    if (dcOnly) {
      // Every row is t[0] and the u = 0 basis is constant, so all 64 samples are equal.
      const value = count ? Math.floor(t[0]! * BASIS[0]! + 0.5) : 0;
      for (let y = 0; y < 8; y++) {
        const row = offset + y * stride;
        if (intra) dest.fill(Math.max(0, Math.min(255, value)), row, row + 8);
        else if (value)
          for (let p = row; p < row + 8; p++)
            dest[p] = Math.max(0, Math.min(255, value + dest[p]!));
      }
      return;
    }
    // Column-major accumulation adds each sample's terms in the same increasing-u order.
    const sums = this.sums;
    sums.fill(0);
    for (let k = 0; k < count; k++) {
      const u = columns[k]!;
      for (let y = 0; y < 8; y++) {
        const value = t[y * 8 + u]!,
          row = y * 8;
        for (let x = 0; x < 8; x++)
          sums[row + x] = sums[row + x]! + value * BASIS_BY_FREQUENCY[u * 8 + x]!;
      }
    }
    for (let y = 0; y < 8; y++) {
      const row = y * 8,
        target = offset + y * stride;
      for (let x = 0; x < 8; x++) {
        const p = target + x,
          n = Math.floor(sums[row + x]! + 0.5) + (intra ? 0 : dest[p]!);
        dest[p] = Math.max(0, Math.min(255, n));
      }
    }
  }
}
