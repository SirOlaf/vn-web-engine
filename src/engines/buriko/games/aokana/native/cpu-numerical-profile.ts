const floatBits = new DataView(new ArrayBuffer(4));
const f32 = Math.fround;

/**
 * Measured Rosetta x86 RCPSS/RCPPS seed profile. The ISA permits other CPU tables.
 * Every mantissa at positive exponents -32..33, and both signs at exponents
 * -16..15, was compared with the native instruction. Consumers handle zero
 * explicitly, including collision's +Infinity seed and resulting refinement NaN.
 */
export function aokanaRosettaSseReciprocal(input: number): number {
  floatBits.setFloat32(0, input, true);
  const bits = floatBits.getUint32(0, true);
  const exponent = (bits >>> 23) & 255;
  if (exponent === 0 || exponent === 255)
    throw new RangeError('Aokana reciprocal is outside its normal finite SSE domain');
  const index = (bits >>> 12) & 2047;
  const normalized = Math.round(8192 / (1 + (index + 0.5) / 2048)) / 8192;
  const result = f32(normalized * 2 ** (127 - exponent));
  return bits >>> 31 ? -result : result;
}

/** Every mantissa at exponents -32..33 was verified against native RSQRTSS. */
export function aokanaRosettaSseReciprocalSqrt(input: number): number {
  floatBits.setFloat32(0, input, true);
  const bits = floatBits.getUint32(0, true);
  const exponentBits = (bits >>> 23) & 255;
  if (bits >>> 31 || exponentBits === 0 || exponentBits === 255)
    throw new RangeError('Aokana reciprocal square root is outside its positive-normal SSE domain');
  const exponent = exponentBits - 127;
  const parity = exponent & 1;
  const index = (bits >>> 13) & 1023;
  const normalized = Math.round(8192 / Math.sqrt((1 + (index + 0.5) / 1024) * 2 ** parity)) / 8192;
  return f32(normalized * 2 ** (-(exponent - parity) / 2));
}
