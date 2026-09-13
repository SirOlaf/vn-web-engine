import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaIndependentProcedures} from './independent-procedure.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** These wrappers address the actual DCIndProc registry shared with the main controller. */
export function createGroup80Procedures(
  procedures: AokanaIndependentProcedures,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xa8,
      nativeAddress: 0x1400e7520,
      name: 'SetIndependentProcedureEnabled',
      execute: (h) => {
        const value = pop32(h.thread),
          procedure = procedures.find(pop32(h.thread));
        procedure?.setEnabled(value);
        push32(h.thread, Number(procedure !== null));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xa9,
      nativeAddress: 0x1400e74d0,
      name: 'ReadIndependentProcedureEnabled',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread)),
          procedure = procedures.find(pop32(h.thread));
        if (procedure !== null) {
          const value = procedure.getEnabled();
          if (output === null) throw new Error('Aokana independent procedure null result pointer');
          pointerView(output, 4).setUint32(0, value, true);
        }
        push32(h.thread, Number(procedure !== null));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xac,
      nativeAddress: 0x1400e7460,
      name: 'QueueIndependentProcedureMessage',
      execute: (h) => {
        const input = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          procedure = procedures.find(pop32(h.thread));
        if (procedure !== null && (count - 1) >>> 0 < 256) {
          if (input === null) throw new Error('Aokana independent procedure null message pointer');
          const source = pointerView(input, count * 4),
            words = new Uint32Array(count);
          for (let index = 0; index < count; index++)
            words[index] = source.getUint32(index * 4, true);
          procedure.enqueue(words);
        }
        // The native wrapper reports existence independently of the queue operation's status.
        push32(h.thread, Number(procedure !== null));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xaf,
      nativeAddress: 0x1400e7430,
      name: 'SetIndependentProcedurePollingPhase',
      execute: (h) => {
        push32(h.thread, procedures.setPollingPhase(pop32(h.thread)));
        return 0;
      },
    },
  ];
}
