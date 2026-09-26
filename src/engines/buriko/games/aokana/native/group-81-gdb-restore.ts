import {pop32, push32} from '../bp/state.js';
import type {AokanaGdbRestore} from './gdb-restore.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Bank 81:80 resolves five live VM pointers and collapses the lower status to boolean. */
export function createGroup81GdbRestore(restore: AokanaGdbRestore): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x80,
      nativeAddress: 0x1400eb100,
      name: 'RestoreGdbFromMemory',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          secondCapacity = h.memory.resolve(h.thread, pop32(h.thread)),
          secondDestination = h.memory.resolve(h.thread, pop32(h.thread)),
          firstCapacity = h.memory.resolve(h.thread, pop32(h.thread)),
          firstDestination = h.memory.resolve(h.thread, pop32(h.thread));
        if (source === null) throw new Error('Aokana GDB restore dereferences a null SDC source');
        push32(
          h.thread,
          Number(
            restore.restore(
              firstDestination,
              firstCapacity,
              secondDestination,
              secondCapacity,
              source,
            ) === 0,
          ),
        );
        return 0;
      },
    },
  ];
}
