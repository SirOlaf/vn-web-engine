import type {OpcodeExecution} from './types.js';

/** 140056820: this build takes selectors 0/3. Other selectors leave PC on the label. */
export function platformBranch(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte();
  if (selector === 0 || selector === 3) {
    const slot = h.context.getUint32(0x74, true),
      label = h.word();
    h.context.setBigUint64(0x158, BigInt(h.labelAddress(slot, label)), true);
  }
}
