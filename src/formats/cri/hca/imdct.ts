import {WINDOW} from './tables.js';
const N = 128;
// Symmetry reduces a 256-point output to 128 dot products. Coefficients are
// generated mathematically, not copied from the native optimized transform.
const MATRIX = new Float64Array(N * N);
for (let row = 0; row < N; row++) {
  const n = row < 64 ? row : row + 64;
  for (let k = 0; k < N; k++)
    MATRIX[row * N + k] =
      Math.cos((Math.PI / N) * (n + 0.5 + N / 2) * (k + 0.5)) * Math.sqrt(2 / N);
}
/** Stateful 50%-overlapped inverse MDCT. Native DSP entry: 1401ad8d8. */
export class HcaImdct {
  private readonly overlap = new Float32Array(N);
  private readonly time = new Float64Array(256);
  reset(): void {
    this.overlap.fill(0);
  }
  process(spectrum: Float32Array, output: Float32Array, offset = 0): void {
    if (
      spectrum.length !== N ||
      offset < 0 ||
      !Number.isInteger(offset) ||
      offset + N > output.length
    )
      throw new Error('Invalid IMDCT buffers');
    for (let row = 0; row < N; row++) {
      let value = 0;
      const base = row * N;
      for (let k = 0; k < N; k++) value += spectrum[k]! * MATRIX[base + k]!;
      if (row < 64) {
        this.time[row] = value;
        this.time[127 - row] = -value;
      } else {
        this.time[row + 64] = value;
        this.time[319 - row] = value;
      }
    }
    for (let i = 0; i < N; i++) {
      output[offset + i] = this.time[i]! * WINDOW[i]! + this.overlap[i]!;
      this.overlap[i] = this.time[N + i]! * WINDOW[N - 1 - i]!;
    }
  }
}
