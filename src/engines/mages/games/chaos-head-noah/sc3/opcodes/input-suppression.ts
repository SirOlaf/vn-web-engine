import type {OpcodeExecution} from './types.js';

/** 10/21, 14005aa70: age the post-transition input guard and swallow confirm/cancel edges. */
export function suppressConfirmCancelInput(h: OpcodeExecution): void {
  h.skip(2);
  const mode = h.byte();
  if (mode !== 1 || h.state.variable(0x36bc / 4) >>> 0 < 32) return;
  const current = h.state.get(0x5a983c);
  if (current === 0) return;
  const remaining = (current - 1) | 0;
  h.state.put(0x5a983c, remaining);
  if (remaining === 0) return;
  const pressed = h.state.get(0x5a70d4);
  if ((pressed & h.state.get(0x872dd4)) !== 0 || (pressed & h.state.get(0x872dd8)) !== 0)
    h.state.put(0x5a70d4, 0);
}
