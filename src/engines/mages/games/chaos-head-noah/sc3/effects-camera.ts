import type {NoahState} from './noah-state.js';
import type {OpcodeExecution} from './opcodes/types.js';
const fields = [0x6c70, 0x6c74, 0x6c78, 0x6c7c, 0x6c8c, 0x6c90, 0x6c94] as const;
const f = Math.fround;
/** SSE CVTTSS2SI returns integer-indefinite on NaN, infinity and overflow. */
function integer(value: number): number {
  return Number.isFinite(value) && value >= -2147483648 && value < 2147483648
    ? Math.trunc(value)
    : -2147483648;
}
function putFloat(s: NoahState, address: number, value: number): void {
  // SSE arithmetic produces the negative quiet-NaN bit pattern for 0/0.
  if (Number.isNaN(value)) s.put(address, 0xffc00000);
  else s.view(address, 4).setFloat32(0, value, true);
}
/** 1400062f0: seven component motion with native ramp/total-duration rules. */
export function beginCameraMotion(
  s: NoahState,
  target: readonly number[],
  duration: number,
  ramp: number,
): void {
  if (target.length !== 7) throw new Error('Camera motion requires seven components');
  duration >>>= 0;
  ramp |= 0;
  const twice = (ramp * 2) >>> 0,
    body = duration <= twice ? duration : (duration - twice) >>> 0;
  const divisor = f((body + ramp) >>> 0);
  for (let i = 0; i < 7; i++) {
    const to = f(i === 3 ? target[i]! >>> 0 : target[i]! | 0),
      from = f(s.variable(fields[i]! / 4));
    putFloat(s, 0x535858 + i * 4, to);
    putFloat(s, 0x535880 + i * 4, from);
    putFloat(s, 0x535838 + i * 4, f(f(to - from) / divisor));
  }
  s.put(0x531fbc, 0);
  s.put(0x53217c, twice + body);
  s.put(0x531fb8, ramp);
}
/** 140006550. Returns true while the native command must retry/yield. */
export function advanceCameraMotion(s: NoahState): boolean {
  const read = (a: number) => s.view(a, 4).getFloat32(0, true);
  s.put(0x531fbc, s.get(0x531fbc) + 1);
  const elapsed = s.get(0x531fbc) >>> 0,
    total = s.get(0x53217c) >>> 0,
    ramp = s.get(0x531fb8) >>> 0;
  if (elapsed === total || s.get(0x17ac374) === 1) {
    for (let i = 0; i < 7; i++) s.setVariable(fields[i]! / 4, integer(read(0x535858 + i * 4)));
    return false;
  }
  let scale: number | undefined;
  if (ramp) {
    if (elapsed <= ramp) scale = elapsed;
    else if (elapsed >= (total - ramp) >>> 0) scale = (total - elapsed) >>> 0;
  }
  for (let i = 0; i < 7; i++) {
    let velocity = read(0x535838 + i * 4);
    if (scale !== undefined) velocity = f(f(f(scale) * velocity) / f(ramp));
    const value = f(read(0x535880 + i * 4) + velocity);
    putFloat(s, 0x535880 + i * 4, value);
    s.setVariable(fields[i]! / 4, integer(value));
  }
  return true;
}
/** Complete camera selector family inside 10/37; caller consumes the selector. */
export function cameraSelector(h: OpcodeExecution, selector: number): boolean {
  const s = h.state,
    angle = (n: number) => Math.trunc(Math.imul(n, 65536) / 360);
  if (selector === 0xc) {
    if (advanceCameraMotion(s)) h.retry();
    return true;
  }
  if (selector === 0xd) {
    const values = [h.expression(), h.expression(), h.expression()];
    for (let i = 0; i < 3; i++) s.setVariable(fields[i]! / 4, angle(values[i]!));
    return true;
  }
  const layouts: Readonly<Record<number, readonly number[]>> = {
    10: [0, 1, 2],
    11: [0, 1, 2],
    14: [0, 1, 2, 3],
    15: [0, 1, 2, 3],
    16: [3],
    17: [3],
    18: [4, 5, 6],
    19: [4, 5, 6],
    80: [0, 1, 2, 3, 4, 5, 6],
    81: [0, 1, 2, 3, 4, 5, 6],
    82: [0, 1, 2, 4, 5, 6],
    83: [0, 1, 2, 4, 5, 6],
  };
  const layout = layouts[selector];
  if (!layout) return false;
  const values = layout.map(() => h.expression()),
    duration = h.expression(),
    ramp = h.expression();
  // Read current values only after every expression has run (expressions can write them).
  const target = fields.map((a) => s.variable(a / 4)),
    relative = !!(selector & 1);
  for (let i = 0; i < layout.length; i++) {
    const field = layout[i]!,
      value = field < 3 ? angle(values[i]!) : values[i]!;
    target[field] = relative ? (target[field]! + value) | 0 : value;
  }
  beginCameraMotion(s, target, duration, ramp);
  return true;
}
