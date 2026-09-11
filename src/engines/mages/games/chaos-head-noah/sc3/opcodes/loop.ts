import type {OpcodeExecution} from './types.js';
/** 00/0f, 1400529d0: one counted-loop slot per context; expression runs every visit. */
export function countedLoop(h: OpcodeExecution): void {
  h.skip(2);
  const c = h.context,
    label = h.word(),
    target = h.labelAddress(c.getUint32(0x74, true), label),
    count = h.expression();
  if (c.getInt32(0x28, true) !== label) {
    c.setInt32(0x24, count, true);
    c.setInt32(0x28, label, true);
  }
  let remaining = c.getInt32(0x24, true);
  if (remaining !== 0) {
    remaining = (remaining - 1) | 0;
    c.setInt32(0x24, remaining, true);
  }
  if (remaining === 0) c.setInt32(0x28, 0xffff, true);
  else c.setBigUint64(0x158, BigInt(target), true);
}
