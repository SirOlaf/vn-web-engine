import {pop32} from '../bp/state.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoNativeSlotDefinition} from './types.js';
/** E89B0/06FF30 writes the actual global consulted by every CProcedure. */
export function createGroup80ProcedureControl(
  procedures: BurikoProcedureState,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x50,
      nativeAddress: 0x1400e89b0,
      name: 'SetProcedureExecutionEnabled',
      execute: (h) => {
        procedures.enabled = pop32(h.thread);
        return 1;
      },
    },
  ];
}
