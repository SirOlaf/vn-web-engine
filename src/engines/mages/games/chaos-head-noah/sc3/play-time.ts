import type {NoahState} from './noah-state.js';

/** Timekeeping block in 14005df40, once per new scheduling pass. */
export function advancePlayTime(s: NoahState): void {
  if (s.get(0x81007c) === 0) s.put(0x17abda4, s.get(0x17abda4) + 1);
  if (s.get(0x17abda4) >>> 0 <= 59) return;
  s.setVariable(0x4340 / 4, Math.min((s.variable(0x4340 / 4) + 1) >>> 0, 3599999));
  s.setVariable(0x222c / 4, s.variable(0x222c / 4) + 1);
  s.put(0x17abda4, 0);
  s.setVariable(0x1f44 / 4, Math.min((s.variable(0x1f44 / 4) + 1) >>> 0, 359999999));
}

/** Text-window opacity block at 14005e303..14005e3e9 in 14005df40. */
export function advanceTextWindows(s: NoahState): void {
  const step = s.get(0x17ac284) !== 0 ? 256 : 8;
  for (let slot = 0; slot < 3; slot++) {
    const index = (0x20e4 + slot * 4) / 4,
      current = s.variable(index) >>> 0;
    s.setVariable(
      index,
      s.flag(0x9c6 + slot)
        ? Math.min(current < 256 ? current + step : current, 256)
        : current > step
          ? current - step
          : 0,
    );
  }
}
