import type {OpcodeExecution} from './types.js';

/** 140054bf0: selector zero writes the audio setting at variable-byte offset 0x4380; all selectors evaluate the operand. */
export function audioSetting(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    value = h.expression();
  if (selector === 0) h.state.setVariable(0x4380 / 4, value);
}
