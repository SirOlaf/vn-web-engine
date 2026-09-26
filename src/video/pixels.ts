import type {YuvFrame} from './frame.js';

/** Limited-range BT.601 conversion for consumers of top-down opaque BGRA samples.
 * MPEG-1 4:2:0 chroma is centered; interpolate at the same texel centers as YuvRenderer. */
export function yuv420ToBgra(frame: YuvFrame): Uint8Array {
  const {width, height, stride, paddedHeight, y, cb, cr} = frame;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    stride < width ||
    stride % 2 !== 0 ||
    paddedHeight < height ||
    paddedHeight % 2 !== 0 ||
    y.length < stride * paddedHeight ||
    cb.length < (stride * paddedHeight) / 4 ||
    cr.length < (stride * paddedHeight) / 4
  )
    throw new RangeError('Invalid planar movie frame');
  const output = new Uint8ClampedArray(width * height * 4),
    chromaStride = stride / 2;
  for (let row = 0; row < height; row++) {
    const py = row / 2 - 0.25,
      top = Math.floor(py),
      dy = py - top;
    const first = Math.max(0, top) * chromaStride;
    const second = Math.min(paddedHeight / 2 - 1, top + 1) * chromaStride;
    for (let x = 0; x < width; x++) {
      const px = x / 2 - 0.25,
        left = Math.floor(px),
        dx = px - left;
      const a = Math.max(0, left),
        b = Math.min(chromaStride - 1, left + 1);
      const luma = ((y[row * stride + x]! - 16) * 255) / 219;
      const blue =
        (((cb[first + a]! * (1 - dx) + cb[first + b]! * dx) * (1 - dy) +
          (cb[second + a]! * (1 - dx) + cb[second + b]! * dx) * dy -
          128) *
          255) /
        224;
      const red =
        (((cr[first + a]! * (1 - dx) + cr[first + b]! * dx) * (1 - dy) +
          (cr[second + a]! * (1 - dx) + cr[second + b]! * dx) * dy -
          128) *
          255) /
        224;
      const p = (row * width + x) * 4;
      output[p] = luma + 1.772 * blue;
      output[p + 1] = luma - 0.344136 * blue - 0.714136 * red;
      output[p + 2] = luma + 1.402 * red;
      output[p + 3] = 255;
    }
  }
  return new Uint8Array(output.buffer);
}
