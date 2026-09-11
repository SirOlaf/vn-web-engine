import type {OpcodeExecution} from './types.js';

/** 140056660: shared native countdown, scaled by scene input speed. */
export function scaledWait(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state;
  if (selector === 0) {
    const value = h.expression();
    s.put(0x17a0c88, (value === 0 ? 180 : value) << 8);
  } else if (selector === 1) {
    if (s.get(0x17ac374) === 1 || s.get(0x17ac284) === 1) {
      s.put(0x17a0c88, 0);
      return;
    }
    const speed = s.get(0x17add38) >>> 0;
    if (speed < 0xffff1000) {
      const step = Math.imul(s.get(0x17abc0c), speed) >>> 0,
        remaining = s.get(0x17a0c88) >>> 0;
      if (remaining <= step) {
        s.put(0x17a0c88, 0);
        return;
      }
      s.put(0x17a0c88, remaining - step);
    }
    if (s.get(0x17a0c88) !== 0) h.retry();
  }
}
