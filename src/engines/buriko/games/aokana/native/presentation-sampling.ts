import {AokanaDisplayTexture} from './display-texture.js';

export type AokanaPresentationColor = [number, number, number, number];
export type AokanaPresentationSampler = 'point' | 'linear';

/** Explicit software device profile: binary32 operations, unfused MAD, rounded reciprocal. */
export const AOKANA_PRESENTATION_NUMERICAL_PROFILE = 'binary32-unfused-mad' as const;
const f32 = Math.fround;
const multiply = (a: number, b: number): number => f32(a * b);
const mad = (a: number, b: number, c: number): number => f32(multiply(a, b) + c);

/** The SHADER/129 resource's a=-1 cubic, retaining its two distinct MAD chains. */
export function aokanaPresentationCubicWeight(distance: number): number {
  const t = Math.abs(f32(distance)),
    square = multiply(t, t);
  const inner = mad(square, t, mad(square, -2, 1));
  const outer = mad(square, -t, mad(square, 5, mad(t, -8, 4)));
  return f32(t - 1) >= 0 ? outer : inner;
}

function texel(texture: AokanaDisplayTexture, x: number, y: number): AokanaPresentationColor {
  if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) return [0, 0, 0, 0];
  const offset = y * texture.pitch + x * 4;
  texture.storage.range(offset, 4, true);
  const bytes = texture.storage.bytes;
  return [
    f32(bytes[offset + 2]! / 255),
    f32(bytes[offset + 1]! / 255),
    f32(bytes[offset]! / 255),
    texture.format === 22 ? 1 : f32(bytes[offset + 3]! / 255),
  ];
}

/** Level zero, transparent-black border addressing, normalized BGRA8 texels. */
export function aokanaPresentationTextureSample(
  texture: AokanaDisplayTexture,
  u: number,
  v: number,
  sampler: AokanaPresentationSampler,
): AokanaPresentationColor {
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
  const output: AokanaPresentationColor = [0, 0, 0, 0];
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
export function aokanaCubicPresentationSample(
  texture: AokanaDisplayTexture,
  width: number,
  height: number,
  u: number,
  v: number,
  sampler: AokanaPresentationSampler,
): AokanaPresentationColor {
  const px = mad(f32(u), f32(texture.width), -0.5),
    py = mad(f32(v), f32(texture.height), -0.5);
  const fx = f32(px - Math.floor(px)),
    fy = f32(py - Math.floor(py));
  const nx = f32(px - fx),
    ny = f32(py - fy);
  const inverseWidth = f32(1 / f32(texture.width)),
    inverseHeight = f32(1 / f32(texture.height));
  const wx = [-1, 0, 1, 2].map((offset) => aokanaPresentationCubicWeight(f32(fx - offset)));
  const wy = [-1, 0, 1, 2].map((offset) => aokanaPresentationCubicWeight(f32(fy - offset)));
  const output: AokanaPresentationColor = [0, 0, 0, 0];
  let denominator = 0;
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      const x = f32(nx + column - 1),
        y = f32(ny + row - 1);
      const color = aokanaPresentationTextureSample(
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
