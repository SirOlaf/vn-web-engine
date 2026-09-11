import type {OpcodeExecution} from './types.js';
import {nativeTrigData} from '../native-trig-data.js';
import {checkRange} from '../../../../../../core/binary.js';
const f = Math.fround;
function table(address: number, index: number): number {
  const offset = (address - 0x1d6820) / 2 + index;
  checkRange(nativeTrigData.length, offset, 1);
  return nativeTrigData[offset]!;
}
/** 14001f610/14001f6a0: rounded 12-bit angle, exact native quarter-wave table. */
function sine(angle: number): number {
  const index = ((angle + 8) >>> 4) & 0xfff,
    quadrant = index & 0xc00;
  if (quadrant === 0) return table(0x1d7850, index);
  if (quadrant === 0x400) return index === 0x400 ? 65536 : table(0x1d7850, 0x800 - index);
  if (quadrant === 0x800) return -table(0x1d7850, index - 0x800);
  return index === 0xc00 ? -65536 : -table(0x1d7850, 0x1000 - index);
}
function cosine(angle: number): number {
  return sine(angle + 0x4000);
}
/** Signed IDIV, including the native arithmetic-fault boundary. */
function divide(a: number, b: number): number {
  if (b === 0 || (a === -2147483648 && b === -1)) throw new Error('Native integer division fault');
  return Math.trunc(a / b) | 0;
}
function atan(x: number, y: number): number {
  if ((x & 0xffffff00) === 0) return 0;
  if ((y & 0xffffff00) === 0) return 0x4000;
  const a = ((x ^ (x >> 31)) - (x >> 31)) | 0,
    b = ((y ^ (y >> 31)) - (y >> 31)) | 0;
  return b < a
    ? 0x4000 - table(0x1d7020, divide(Math.imul(b, 1024), a))
    : table(0x1d7020, divide(Math.imul(a, 1024), b));
}
/** Entire 01/05 (14004ade0), including native ignored selectors. */
export function mathCommand(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte();
  if (mode > 6) return;
  const destination = h.expression(),
    a = h.expression();
  let value: number;
  if (mode < 2) value = (mode === 0 ? sine : cosine)(a & 65535);
  else {
    const b = h.expression();
    if (mode === 2) {
      const angle = atan(a, b);
      value = a < 0 ? (b < 0 ? angle + 0x8000 : -angle) : b < 0 ? 0x8000 - angle : angle;
    } else {
      const c = h.expression();
      if (mode < 5) value = (Math.imul((mode === 3 ? sine : cosine)(b & 65535), a) + c) | 0;
      else if (mode === 5) {
        const rounded = f(f(f(f(f(f(b) * f(a)) * 10) / f(c)) + 5) / 10);
        value =
          Number.isFinite(rounded) && rounded >= -2147483648 && rounded < 2147483648
            ? Math.trunc(rounded)
            : -2147483648;
      } else if (c <= 1) value = a;
      else {
        const quadratic = divide(divide(Math.imul(Math.imul(Math.imul(b, b), a), 10), c), c);
        value = divide((divide(Math.imul(Math.imul(b, a), 20), c) - quadratic + 5) | 0, 10);
      }
    }
  }
  h.state.setVariable(destination, value);
}
