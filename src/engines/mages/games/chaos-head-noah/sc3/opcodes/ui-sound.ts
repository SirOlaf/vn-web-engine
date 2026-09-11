import type {OpcodeExecution} from './types.js';

/** 1400543d0 / 140028b00: the replaceable system-sound voice (sysse bank). */
export function uiSound(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte(),
    id = h.expression();
  const parameter = mode === 0 ? h.expression() : 0;
  if (mode !== 0 && (mode !== 1 || id === 65535)) return;
  const volume =
    Math.trunc(Math.fround(Math.fround(Math.fround(h.state.get(0x17ac2e8) >>> 0) * 70) / 100)) >>>
    0;
  h.state.put(0x5a7100, volume);
  if (mode === 0 && id === 65535 && parameter === -1) return;
  // The second mode-0 operand is consumed but only participates in that sentinel.
  h.sound(id, volume);
}
