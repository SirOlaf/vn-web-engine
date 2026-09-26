import {BurikoDisplayTexture} from './display-texture.js';

export type BurikoPresentationColor = [number, number, number, number];
export type BurikoPresentationSampler = 'point' | 'linear';

/** Explicit software device profile: binary32 operations, unfused MAD, rounded reciprocal. */
export const BURIKO_PRESENTATION_NUMERICAL_PROFILE = 'binary32-unfused-mad' as const;
const f32 = Math.fround;
const multiply = (a: number, b: number): number => f32(a * b);
const mad = (a: number, b: number, c: number): number => f32(multiply(a, b) + c);
const normalizedByte = Float32Array.from({length: 256}, (_, value) => f32(value / 255));

/** The SHADER/129 resource's a=-1 cubic, retaining its two distinct MAD chains. */
export function burikoPresentationCubicWeight(distance: number): number {
  const t = Math.abs(f32(distance)),
    square = multiply(t, t);
  const inner = mad(square, t, mad(square, -2, 1));
  const outer = mad(square, -t, mad(square, 5, mad(t, -8, 4)));
  return f32(t - 1) >= 0 ? outer : inner;
}

function texel(texture: BurikoDisplayTexture, x: number, y: number): BurikoPresentationColor {
  const output: BurikoPresentationColor = [0, 0, 0, 0];
  texelInto(texture, x, y, output);
  return output;
}

/** Reuse color vectors while rasterizing one frame; standalone samples retain read checks. */
export interface BurikoPresentationSampleScratch {
  readonly a: BurikoPresentationColor;
  readonly b: BurikoPresentationColor;
  readonly c: BurikoPresentationColor;
  readonly d: BurikoPresentationColor;
}

/** One synchronous raster pass over a display texture whose backing is fully initialized. */
export interface BurikoPresentationFrameRead {
  validated: boolean;
}

function texelInto(
  texture: BurikoDisplayTexture,
  x: number,
  y: number,
  output: BurikoPresentationColor,
  frameRead?: BurikoPresentationFrameRead,
): void {
  if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
    output[0] = output[1] = output[2] = output[3] = 0;
    return;
  }
  const offset = y * texture.pitch + x * 4;
  if (!frameRead?.validated) {
    texture.storage.range(offset, 4, true);
    if (frameRead) frameRead.validated = true;
  }
  const bytes = texture.storage.bytes;
  output[0] = normalizedByte[bytes[offset + 2]!]!;
  output[1] = normalizedByte[bytes[offset + 1]!]!;
  output[2] = normalizedByte[bytes[offset]!]!;
  output[3] = texture.format === 22 ? 1 : normalizedByte[bytes[offset + 3]!]!;
}

/** The frame path supplies reusable vectors; standalone callers still receive owned colors. */
export function burikoPresentationTextureSampleInto(
  texture: BurikoDisplayTexture,
  u: number,
  v: number,
  sampler: BurikoPresentationSampler,
  output: BurikoPresentationColor,
  scratch: BurikoPresentationSampleScratch,
  frameRead?: BurikoPresentationFrameRead,
): BurikoPresentationColor {
  const x = multiply(f32(u), f32(texture.width)),
    y = multiply(f32(v), f32(texture.height));
  if (sampler === 'point') {
    texelInto(texture, Math.floor(x), Math.floor(y), output, frameRead);
    return output;
  }
  const px = f32(x - 0.5),
    py = f32(y - 0.5),
    nx = Math.floor(px),
    ny = Math.floor(py);
  const fx = f32(px - nx),
    fy = f32(py - ny);
  texelInto(texture, nx, ny, scratch.a, frameRead);
  texelInto(texture, nx + 1, ny, scratch.b, frameRead);
  texelInto(texture, nx, ny + 1, scratch.c, frameRead);
  texelInto(texture, nx + 1, ny + 1, scratch.d, frameRead);
  for (let channel = 0; channel < 4; channel++) {
    const top = mad(scratch.b[channel]!, fx, multiply(scratch.a[channel]!, f32(1 - fx)));
    const bottom = mad(scratch.d[channel]!, fx, multiply(scratch.c[channel]!, f32(1 - fx)));
    output[channel] = mad(bottom, fy, multiply(top, f32(1 - fy)));
  }
  return output;
}

/** Raster-only RGB path: the X/Y coordinate split is shared by an entire output column/row. */
export function burikoPresentationLinearRgbInto(
  texture: BurikoDisplayTexture,
  nx: number,
  ny: number,
  fx: number,
  fy: number,
  output: BurikoPresentationColor,
  frameRead: BurikoPresentationFrameRead,
): void {
  const left = nx >= 0 && nx < texture.width;
  const right = nx + 1 >= 0 && nx + 1 < texture.width;
  const top = ny >= 0 && ny < texture.height;
  const bottom = ny + 1 >= 0 && ny + 1 < texture.height;
  const a = left && top ? ny * texture.pitch + nx * 4 : -1;
  const b = right && top ? ny * texture.pitch + (nx + 1) * 4 : -1;
  const c = left && bottom ? (ny + 1) * texture.pitch + nx * 4 : -1;
  const d = right && bottom ? (ny + 1) * texture.pitch + (nx + 1) * 4 : -1;
  if (!frameRead.validated) {
    const first = a >= 0 ? a : b >= 0 ? b : c >= 0 ? c : d;
    if (first >= 0) {
      texture.storage.range(first, 4, true);
      frameRead.validated = true;
    }
  }
  const bytes = texture.storage.bytes;
  const oneMinusX = f32(1 - fx);
  const oneMinusY = f32(1 - fy);
  for (let channel = 0; channel < 3; channel++) {
    const byte = 2 - channel;
    const av = a < 0 ? 0 : normalizedByte[bytes[a + byte]!]!;
    const bv = b < 0 ? 0 : normalizedByte[bytes[b + byte]!]!;
    const cv = c < 0 ? 0 : normalizedByte[bytes[c + byte]!]!;
    const dv = d < 0 ? 0 : normalizedByte[bytes[d + byte]!]!;
    const topColor = mad(bv, fx, multiply(av, oneMinusX));
    const bottomColor = mad(dv, fx, multiply(cv, oneMinusX));
    output[channel] = mad(bottomColor, fy, multiply(topColor, oneMinusY));
  }
}

/** Finite-coordinate horizontal half, after the raster pass validates its first texel read. */
export function burikoPresentationLinearRgbRowInto(
  texture: BurikoDisplayTexture,
  sourceX: Float64Array,
  fractionX: Float32Array,
  y: number,
  output: Float32Array,
): void {
  if (y < 0 || y >= texture.height) {
    output.fill(0);
    return;
  }
  const bytes = texture.storage.bytes;
  const row = y * texture.pitch;
  for (let column = 0, offset = 0; column < sourceX.length; column++, offset += 3) {
    const x = sourceX[column]!;
    const a = x >= 0 && x < texture.width ? row + x * 4 : -1;
    const b = x + 1 >= 0 && x + 1 < texture.width ? row + (x + 1) * 4 : -1;
    const fx = fractionX[column]!;
    // Normalized bytes and border zero are finite: the zero-weight MAD is an identity.
    if (fx === 0) {
      output[offset] = a < 0 ? 0 : normalizedByte[bytes[a + 2]!]!;
      output[offset + 1] = a < 0 ? 0 : normalizedByte[bytes[a + 1]!]!;
      output[offset + 2] = a < 0 ? 0 : normalizedByte[bytes[a]!]!;
      continue;
    }
    const oneMinusX = f32(1 - fx);
    const ar = a < 0 ? 0 : normalizedByte[bytes[a + 2]!]!;
    const ag = a < 0 ? 0 : normalizedByte[bytes[a + 1]!]!;
    const ab = a < 0 ? 0 : normalizedByte[bytes[a]!]!;
    const br = b < 0 ? 0 : normalizedByte[bytes[b + 2]!]!;
    const bg = b < 0 ? 0 : normalizedByte[bytes[b + 1]!]!;
    const bb = b < 0 ? 0 : normalizedByte[bytes[b]!]!;
    output[offset] = mad(br, fx, multiply(ar, oneMinusX));
    output[offset + 1] = mad(bg, fx, multiply(ag, oneMinusX));
    output[offset + 2] = mad(bb, fx, multiply(ab, oneMinusX));
  }
}

/** Vertical half, with the same binary32 MAD and XRGB UNORM conversion as each sample. */
export function burikoPresentationLinearRgbBlendInto(
  top: Float32Array,
  bottom: Float32Array,
  fy: number,
  pixels: Uint8ClampedArray,
  offset: number,
): void {
  // Horizontal rows contain finite binary32 values, including transparent-black borders.
  if (fy === 0) {
    for (let index = 0; index < top.length; index += 3, offset += 4) {
      pixels[offset] = f32(top[index]! * 255);
      pixels[offset + 1] = f32(top[index + 1]! * 255);
      pixels[offset + 2] = f32(top[index + 2]! * 255);
      pixels[offset + 3] = 255;
    }
    return;
  }
  const oneMinusY = f32(1 - fy);
  for (let index = 0; index < top.length; index += 3, offset += 4) {
    pixels[offset] = f32(mad(bottom[index]!, fy, multiply(top[index]!, oneMinusY)) * 255);
    pixels[offset + 1] = f32(
      mad(bottom[index + 1]!, fy, multiply(top[index + 1]!, oneMinusY)) * 255,
    );
    pixels[offset + 2] = f32(
      mad(bottom[index + 2]!, fy, multiply(top[index + 2]!, oneMinusY)) * 255,
    );
    pixels[offset + 3] = 255;
  }
}

/** Level zero, transparent-black border addressing, normalized BGRA8 texels. */
export function burikoPresentationTextureSample(
  texture: BurikoDisplayTexture,
  u: number,
  v: number,
  sampler: BurikoPresentationSampler,
): BurikoPresentationColor {
  const x = multiply(f32(u), f32(texture.width)),
    y = multiply(f32(v), f32(texture.height));
  if (sampler === 'point') return texel(texture, Math.floor(x), Math.floor(y));
  const px = f32(x - 0.5),
    py = f32(y - 0.5),
    nx = Math.floor(px),
    ny = Math.floor(py);
  const fx = f32(px - nx),
    fy = f32(py - ny);
  const a = texel(texture, nx, ny),
    b = texel(texture, nx + 1, ny),
    c = texel(texture, nx, ny + 1),
    d = texel(texture, nx + 1, ny + 1);
  const output: BurikoPresentationColor = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    const top = mad(b[channel]!, fx, multiply(a[channel]!, f32(1 - fx)));
    const bottom = mad(d[channel]!, fx, multiply(c[channel]!, f32(1 - fx)));
    output[channel] = mad(bottom, fy, multiply(top, f32(1 - fy)));
  }
  return output;
}

/**
 * SHADER/129's sixteen TEXLDs and independent row-major color/weight sums.
 * Discarded image-edge taps do not contribute. Sampler state is inherited from
 * the last fixed-function pass, as b1470 does not change it in the shader branch.
 */
export function burikoCubicPresentationSample(
  texture: BurikoDisplayTexture,
  width: number,
  height: number,
  u: number,
  v: number,
  sampler: BurikoPresentationSampler,
): BurikoPresentationColor {
  const px = mad(f32(u), f32(texture.width), -0.5),
    py = mad(f32(v), f32(texture.height), -0.5);
  const fx = f32(px - Math.floor(px)),
    fy = f32(py - Math.floor(py));
  const nx = f32(px - fx),
    ny = f32(py - fy);
  const inverseWidth = f32(1 / f32(texture.width)),
    inverseHeight = f32(1 / f32(texture.height));
  const wx = [-1, 0, 1, 2].map((offset) => burikoPresentationCubicWeight(f32(fx - offset)));
  const wy = [-1, 0, 1, 2].map((offset) => burikoPresentationCubicWeight(f32(fy - offset)));
  const output: BurikoPresentationColor = [0, 0, 0, 0];
  let denominator = 0;
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      const x = f32(nx + column - 1),
        y = f32(ny + row - 1);
      const color = burikoPresentationTextureSample(
        texture,
        multiply(f32(x + 0.5), inverseWidth),
        multiply(f32(y + 0.5), inverseHeight),
        sampler,
      );
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const weight = multiply(wx[column]!, wy[row]!);
      if (row === 0 && column === 0) {
        for (let channel = 0; channel < 4; channel++)
          output[channel] = multiply(color[channel]!, weight);
        denominator = weight;
      } else {
        for (let channel = 0; channel < 4; channel++)
          output[channel] = mad(color[channel]!, weight, output[channel]!);
        denominator = mad(wx[column]!, wy[row]!, denominator);
      }
    }
  const inverseDenominator = f32(1 / denominator);
  for (let channel = 0; channel < 4; channel++)
    output[channel] = multiply(output[channel]!, inverseDenominator);
  return output;
}
