/** C runtime `%.*g` of a finite double, from its exact binary value with ties rounded to
 * even (the UCRT printf rule since Windows 10 2004; earlier CRTs rounded ties away from
 * zero). Precision 0 means 1. Infinities and NaN are formatted by the caller. */
export function formatCGeneral(value: number, precision: number): string {
  if (!Number.isFinite(value)) throw new Error('formatCGeneral requires a finite value');
  if (!Number.isInteger(precision) || precision < 0) throw new Error('Invalid %g precision');
  const digitsWanted = Math.max(precision, 1);
  const negative = value < 0 || Object.is(value, -0),
    sign = negative ? '-' : '';
  if (value === 0) return sign + '0';
  // value = mantissa * 2^exponent exactly.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const high = view.getUint32(0),
    biased = high >>> 20;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let exponent = biased - 1075;
  if (biased) mantissa |= 1n << 52n;
  else exponent = -1074;
  const numerator = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa,
    denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  const limit = 10n ** BigInt(digitsWanted);
  // Rounded significand with `digitsWanted` digits for decimal exponent `x`.
  const scaled = (x: number): bigint => {
    const shift = digitsWanted - 1 - x;
    const n = shift >= 0 ? numerator * 10n ** BigInt(shift) : numerator,
      d = shift >= 0 ? denominator : denominator * 10n ** BigInt(-shift);
    let q = n / d;
    const twice = (n % d) * 2n;
    if (twice > d || (twice === d && q % 2n === 1n)) q++;
    return q;
  };
  let x = Math.floor(Math.log10(Math.abs(value)));
  let q = scaled(x);
  while (q >= limit) q = scaled(++x);
  while (q < limit / 10n) q = scaled(--x);
  const digits = q.toString();
  const trim = (fraction: string) => fraction.replace(/0+$/, '');
  if (x < -4 || x >= digitsWanted) {
    const fraction = trim(digits.slice(1));
    const power = Math.abs(x).toString().padStart(2, '0');
    return `${sign}${digits[0]}${fraction ? '.' + fraction : ''}e${x < 0 ? '-' : '+'}${power}`;
  }
  const whole = x >= 0 ? digits.slice(0, x + 1) : '0',
    fraction = trim(x >= 0 ? digits.slice(x + 1) : '0'.repeat(-x - 1) + digits);
  return `${sign}${whole}${fraction ? '.' + fraction : ''}`;
}
