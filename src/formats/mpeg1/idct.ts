// Separable orthonormal inverse DCT. Float64 intermediates avoid intermediate rounding drift.
const BASIS = Float64Array.from({length: 64}, (_, i) => {
  const x = i >> 3,
    u = i & 7;
  return (u ? 0.5 : Math.SQRT1_2 * 0.5) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});
export class MpegIdct {
  private readonly temp = new Float64Array(64);
  add(coeff: Int32Array, dest: Uint8Array, offset: number, stride: number, intra: boolean): void {
    const t = this.temp;
    for (let u = 0; u < 8; u++) {
      let onlyDc = true;
      for (let v = 1; v < 8; v++)
        if (coeff[v * 8 + u]) {
          onlyDc = false;
          break;
        }
      if (onlyDc) {
        const dc = coeff[u]! * BASIS[0]!;
        for (let y = 0; y < 8; y++) t[y * 8 + u] = dc;
      } else
        for (let y = 0; y < 8; y++) {
          let sum = 0;
          for (let v = 0; v < 8; v++) sum += coeff[v * 8 + u]! * BASIS[y * 8 + v]!;
          t[y * 8 + u] = sum;
        }
    }
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += t[y * 8 + u]! * BASIS[x * 8 + u]!;
        const p = offset + y * stride + x,
          n = Math.floor(sum + 0.5) + (intra ? 0 : dest[p]!);
        dest[p] = Math.max(0, Math.min(255, n));
      }
  }
}
