/**
 * Swaps bytes 0 and 2 of every 4-byte texel: BGRA (Direct3D `D3DFMT_A8R8G8B8` and Kirikiri
 * layer memory) to RGBA (WebGL `RGBA`/`UNSIGNED_BYTE`, canvas `ImageData`), or back. `output`
 * may be `source` for an in-place swap.
 */
export function swapRedBlue(
  source: Uint8Array,
  output: Uint8Array | Uint8ClampedArray = new Uint8Array(source.length),
): Uint8Array | Uint8ClampedArray {
  if (source.length % 4 !== 0) throw new RangeError('Texel data is not a multiple of 4 bytes');
  if (output.length < source.length) throw new RangeError('Output is too small');
  for (let i = 0; i < source.length; i += 4) {
    const first = source[i]!;
    output[i] = source[i + 2]!;
    output[i + 1] = source[i + 1]!;
    output[i + 2] = first;
    output[i + 3] = source[i + 3]!;
  }
  return output;
}
