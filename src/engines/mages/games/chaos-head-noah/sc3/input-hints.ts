import type {NoahState} from './noah-state.js';

/** 14001e1ed–14001e213, after device polling and before the mouse-mode gate.
 * This is activity, not connection status or the configurable input layout.
 * Mouse input leaves the selection unchanged; keyboard wins simultaneous input. */
export function updateInputHints(s: NoahState): void {
  if (s.view(0x1dd9ca0, 8).getBigUint64(0, true) !== 0n) s.put(0x20d22c, 0);
  if (s.bytes(0x1baf0e0, 1)[0]) s.put(0x20d22c, 1);
}
