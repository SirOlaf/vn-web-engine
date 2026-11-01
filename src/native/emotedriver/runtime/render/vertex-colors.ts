/**
 * Packed corner-color interpolation shared by the two exact native builds:
 * x86 a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86;
 * x64 80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051.
 */
/** Fixed-point corner interpolation along a line of `count` cells (x86 0x1002ab90, x64 0x180030320). */
function lerpLine(colors: Uint32Array, start: number, count: number, stride: number): void {
  if (count <= 2) return;
  const a = colors[start]!,
    b = colors[start + (count - 1) * stride]!;
  if (a === b) {
    for (let k = 1; k < count - 1; k++) colors[start + k * stride] = a;
    return;
  }
  const steps = count - 1,
    aLow = a & 0xff00ff,
    bLow = b & 0xff00ff,
    aHigh = (a >>> 8) & 0xff00ff,
    bHigh = (b >>> 8) & 0xff00ff;
  for (let k = 1; k < steps; k++) {
    const t = ((k * 256) / steps) >>> 0,
      s = 256 - t,
      low = ((Math.imul(t, bLow) + Math.imul(s, aLow)) >>> 0) >>> 8,
      high = (Math.imul(t, bHigh) + Math.imul(s, aHigh)) >>> 0;
    colors[start + k * stride] = (((low ^ high) & 0xff00ff) ^ high) >>> 0;
  }
}

/**
 * Per-vertex colours of a (columns + 1) × (rows + 1) grid from four corners
 * [top-left, top-right, bottom-left, bottom-right] (x86 0x1002dc40, x64 0x180032250).
 */
export function emoteGridColors(
  corners: Uint32Array,
  columns: number,
  rows: number,
  storage?: Uint32Array,
): Uint32Array {
  const across = columns + 1,
    down = rows + 1,
    // Every entry is written below, so reused storage needs no clearing.
    out =
      storage && storage.length >= across * down
        ? storage.subarray(0, across * down)
        : new Uint32Array(across * down);
  const c0 = corners[0]!;
  if (corners[1] === c0 && corners[2] === c0 && corners[3] === c0) {
    out.fill(c0);
    return out;
  }
  out[0] = c0;
  out[across - 1] = corners[1]!;
  out[rows * across] = corners[2]!;
  out[across * down - 1] = corners[3]!;
  lerpLine(out, 0, down, across);
  lerpLine(out, across - 1, down, across);
  for (let row = 0; row < down; row++) lerpLine(out, row * across, across, 1);
  return out;
}
