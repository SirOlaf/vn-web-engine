import type {OpcodeExecution} from './types.js';

/** 14004aae0: synchronously release one graphics surface when loading is idle. */
export function releaseSurface(h: OpcodeExecution): void {
  if (h.state.get(0x81007c) !== 0) {
    h.yield();
    return;
  }
  h.skip(2);
  h.textures.release(h.expression());
}
