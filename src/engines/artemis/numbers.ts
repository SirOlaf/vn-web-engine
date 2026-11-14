/** Windows unsigned-long hexadecimal prefix conversion, used by this revision's colors. */
export function artemisHexUint32(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?)(?:0[xX])?([0-9a-fA-F]+)/.exec(value);
  const digits = token?.[2]?.replace(/^0+/, '') ?? '';
  const overflow = digits.length > 8;
  const magnitude = overflow ? 0xffffffff : digits ? Number.parseInt(digits, 16) : 0;
  return (overflow ? magnitude : token?.[1] === '-' ? -magnitude : magnitude) >>> 0;
}

/** Finite decimal prefix subset of native atof, before any caller-specific float rounding. */
export function artemisDecimal(
  value: string,
  errorMessage = 'Unsupported Artemis decimal number',
): number {
  const input = value.split('\0', 1)[0]!;
  if (/^[\t\n\v\f\r ]*[+-]?(?:0x|inf|nan)/i.test(input)) throw Error(errorMessage);
  const token = /^[\t\n\v\f\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(input);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isFinite(number)) throw Error(errorMessage);
  return number;
}
/** Signed int32 prefix subset of Windows atoi; overflow remains explicitly unsupported. */
export function artemisInteger(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw Error('Unsupported Artemis integer');
  return number;
}
