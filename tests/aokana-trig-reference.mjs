// Independent mathematical oracle: 224-bit fixed-point Taylor series, reduced
// with a decimal PI constant. It does not reuse the CRT polynomial, 2/PI table,
// three-word reducer, or the runtime's host Math.sin/Math.cos implementation.
const precision = 224n,
  scale = 1n << precision;
const piDigits =
  '31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679';
const pi = (BigInt(piDigits) * scale) / 10n ** BigInt(piDigits.length - 1);
const scratch = new DataView(new ArrayBuffer(8));
function exactScaledDouble(value) {
  scratch.setFloat64(0, value, true);
  const bits = scratch.getBigUint64(0, true);
  const shift = BigInt(Number((bits >> 52n) & 2047n) - 1023 - 52) + precision;
  const significand = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  const magnitude = shift >= 0n ? significand << shift : significand >> -shift;
  return bits >> 63n !== 0n ? -magnitude : magnitude;
}
export function referenceSineCosine(radians) {
  if (radians === 0) return {sine: radians, cosine: 1};
  const angle = exactScaledDouble(radians);
  const halfPi = pi / 2n;
  const quadrant = (angle + (angle < 0n ? -halfPi / 2n : halfPi / 2n)) / halfPi;
  const reduced = angle - quadrant * halfPi;
  const square = (reduced * reduced) / scale;
  let sine = reduced,
    sineTerm = reduced,
    cosine = scale,
    cosineTerm = scale;
  for (let n = 1n; n < 80n; n++) {
    sineTerm = (-sineTerm * square) / (scale * (n * 2n) * (n * 2n + 1n));
    cosineTerm = (-cosineTerm * square) / (scale * (n * 2n - 1n) * (n * 2n));
    sine += sineTerm;
    cosine += cosineTerm;
    if (sineTerm === 0n && cosineTerm === 0n) break;
  }
  const s = Number(sine) / Number(scale),
    c = Number(cosine) / Number(scale);
  switch (Number(((quadrant % 4n) + 4n) % 4n)) {
    case 0:
      return {sine: s, cosine: c};
    case 1:
      return {sine: c, cosine: -s};
    case 2:
      return {sine: -s, cosine: -c};
    default:
      return {sine: -c, cosine: s};
  }
}
