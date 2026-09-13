import type {AokanaDisplayManager} from '../../native/display-manager.js';
import type {AokanaBpOpcodeHandler} from '../../native/types.js';
import {pop32, push32} from '../state.js';

/** Primary 77: 0cd3a0 -> 0b6000 -> 07fc80 reads the actual shared manager's category count. */
export function createPrimaryDisplayOpcodes(
  manager: AokanaDisplayManager,
): Readonly<Record<number, AokanaBpOpcodeHandler>> {
  return {
    0x77: (h) => {
      push32(h.thread, manager.categoryCount(pop32(h.thread)));
      return 0;
    },
  };
}
