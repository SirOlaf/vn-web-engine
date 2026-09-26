import type {BurikoDisplayManager} from '../../native/display-manager.js';
import type {BurikoBpOpcodeHandler} from '../../native/types.js';
import {pop32, push32} from '../state.js';

/** Primary 77: 0cd3a0 -> 0b6000 -> 07fc80 reads the actual shared manager's category count. */
export function createPrimaryDisplayOpcodes(
  manager: BurikoDisplayManager,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x77: (h) => {
      push32(h.thread, manager.categoryCount(pop32(h.thread)));
      return 0;
    },
  };
}
