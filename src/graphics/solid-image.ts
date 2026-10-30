import type {TriangleImage} from './triangle-draw.js';
import type {Rgba} from './surface.js';

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Straight RGBA fill, preserving RGB even for fully transparent pixels. */
export function createSolidImage(width: number, height: number, color: Rgba): TriangleImage {
  const size = width * height * 4;
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 0 && n <= 0x7fffffff) ||
    !Number.isSafeInteger(size) ||
    size > 0x7fffffff
  )
    throw new Error('Unsupported solid image dimensions');
  if (color.length !== 4 || !color.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
    throw new Error('Invalid solid image RGBA color');
  const [r, g, b, a] = color;
  const packed = littleEndian
    ? r | (g << 8) | (b << 16) | (a << 24)
    : (r << 24) | (g << 16) | (b << 8) | a;
  const pixels = new Uint8Array(size);
  new Uint32Array(pixels.buffer).fill(packed);
  return {width, height, pixels};
}
