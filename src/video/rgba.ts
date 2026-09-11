import type {YuvFrame} from './frame.js';
/** Limited-range BT.601, centered bilinear 4:2:0 (same sampling as YuvRenderer). */
export function movieRgba(frame: YuvFrame): {width: number; height: number; pixels: Uint8Array} {
  const {width, height, stride, paddedHeight, y, cb, cr} = frame,
    pixels = new Uint8Array(width * height * 4),
    cw = stride / 2,
    ch = paddedHeight / 2;
  const chroma = (plane: Uint8Array, x: number, y: number) => {
    const px = (x - 0.5) / 2,
      py = (y - 0.5) / 2,
      x0 = Math.floor(px),
      y0 = Math.floor(py),
      fx = px - x0,
      fy = py - y0;
    const sample = (a: number, b: number) =>
      plane[Math.max(0, Math.min(ch - 1, b)) * cw + Math.max(0, Math.min(cw - 1, a))]!;
    return (
      (sample(x0, y0) * (1 - fx) + sample(x0 + 1, y0) * fx) * (1 - fy) +
      (sample(x0, y0 + 1) * (1 - fx) + sample(x0 + 1, y0 + 1) * fx) * fy
    );
  };
  const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const l = ((y[row * stride + col]! - 16) * 255) / 219,
        b = ((chroma(cb, col, row) - 128) * 255) / 224,
        r = ((chroma(cr, col, row) - 128) * 255) / 224,
        i = (row * width + col) * 4;
      pixels[i] = byte(l + 1.402 * r);
      pixels[i + 1] = byte(l - 0.344136 * b - 0.714136 * r);
      pixels[i + 2] = byte(l + 1.772 * b);
      pixels[i + 3] = 255;
    }
  return {width, height, pixels};
}
