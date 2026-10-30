export type SseRounding = 'nearest-even' | 'down' | 'up' | 'toward-zero';

/** Signed32 CVTSD2SI conversion with the caller's explicit rounding mode.
 * Invalid/overflow returns the native masked-invalid indefinite integer.
 */
export function sseInt32(value: number, rounding: SseRounding): number {
  let integer: number;
  switch (rounding) {
    case 'nearest-even': {
      const below = Math.floor(value),
        fraction = value - below;
      integer = fraction > 0.5 || (fraction === 0.5 && below % 2 !== 0) ? below + 1 : below;
      break;
    }
    case 'down':
      integer = Math.floor(value);
      break;
    case 'up':
      integer = Math.ceil(value);
      break;
    case 'toward-zero':
      integer = Math.trunc(value);
      break;
    default:
      throw Error('Unsupported SSE rounding mode');
  }
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer | 0;
}
