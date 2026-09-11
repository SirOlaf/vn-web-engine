import type {OpcodeExecution} from './types.js';
/** 00/15, 140052e00. Raw native input banks, including selector fallthrough. */
export function inputMaskJump(h: OpcodeExecution): void {
  h.skip(2);
  let polarity = h.byte();
  let mask = h.expression();
  const selector = h.expression() >>> 0;
  const target = h.labelAddress(h.context.getUint32(0x74, true), h.word());
  if (polarity & 2) {
    polarity &= 1;
    mask = h.state.get(0x872dc0 + mask * 4);
  }
  const banks = [0x5a70d0, 0x5a70d4, 0x5a6f74, 0x58734c];
  const value = selector < 4 ? Number((h.state.get(banks[selector]!) & mask) !== 0) : selector;
  if (polarity === value) h.context.setBigUint64(0x158, BigInt(target), true);
}
/** 00/53, 1400569d0. Resolve the label before querying even on an untaken branch. */
export function inputJump(h: OpcodeExecution): void {
  h.skip(2);
  const polarity = h.byte(),
    action = h.expression();
  const target = h.labelAddress(h.context.getUint32(0x74, true), h.word());
  if ((polarity & 1) === h.input.query(action)) h.context.setBigUint64(0x158, BigInt(target), true);
}
