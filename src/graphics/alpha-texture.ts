import type {TriangleImage} from './triangle-draw.js';

/** D3D9 A8 texture sampling through RGBA targets: RGB is zero and alpha is the supplied
 * byte channel. The caller owns this upload view separately from the source image. */
export function createAlphaTextureImage(
  source: TriangleImage,
  channel: 'red' | 'alpha',
): TriangleImage {
  if (source.pixels.length !== source.width * source.height * 4)
    throw Error('Invalid alpha texture source');
  const pixels = new Uint8Array(source.pixels.length),
    component = channel === 'red' ? 0 : 3;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 3] = source.pixels[i + component]!;
  }
  return {width: source.width, height: source.height, pixels};
}
