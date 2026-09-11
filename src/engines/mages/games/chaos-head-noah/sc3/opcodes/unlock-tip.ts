import {checkRange} from '../../../../../../core/binary.js';
import type {OpcodeExecution} from './types.js';

/** 14005b0c0: explicit TIPS unlock, notification, recent list and optional result flag. */
export function unlockTip(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    id = h.expression() >>> 0,
    flag = selector === 1 ? h.expression() >>> 0 : 0,
    s = h.state;
  const bit = Math.imul(id, 3) >>> 0,
    byte = bit >>> 3,
    mask = 1 << (bit & 7);
  checkRange(s.auxiliary.length, byte, 1);
  const previous = s.auxiliary[byte]! & mask;
  if (!previous) {
    s.auxiliary[byte] = s.auxiliary[byte]! | mask;
    if (selector < 2 && s.get(0x17adca0) !== 0) {
      const n = s.get(0x5afabc) >>> 0;
      s.put(0x5afae0 + n * 12, id);
      s.put(0x5afae4 + n * 12, 0);
      const width = h.messageBoxes.measure(
        h.messageAddress(s.get(0x5a9838) >>> 0, (s.get(0x5a7704 + id * 28) + 100) >>> 0),
        20,
      );
      const next = s.get(0x5afabc) >>> 0;
      s.put(0x5afabc, next + 1);
      s.put(0x5afae8 + next * 12, width);
    }
    const recent = s.get(0x5b0a3c) >>> 0;
    s.put(0x5a9840 + recent * 2, id, 2);
    s.put(0x5b0a3c, recent + 1);
  }
  if (selector === 1) s.setFlag(flag, previous ? 0 : 1);
  s.setVariable(0x2430 / 4, id);
}
