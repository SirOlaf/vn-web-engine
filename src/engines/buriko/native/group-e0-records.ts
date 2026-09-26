import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {BurikoDiagnosticCounts, BurikoPooledAllocationDiagnostics} from './diagnostic-records.js';

/** The four E0 state/array leaves; file and display wrappers are separate complete batches. */
export function createGroupE0Records(
  counts: BurikoDiagnosticCounts,
  allocations: BurikoPooledAllocationDiagnostics,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x90,
      nativeAddress: 0x1400aae90,
      name: 'ClearDiagnosticCounts',
      execute: () => {
        counts.clear();
        return 0;
      },
    },
    {
      primary: 0xe0,
      secondary: 0x91,
      nativeAddress: 0x1400aae60,
      name: 'EnumerateDiagnosticCounts',
      execute: (h) => {
        push32(h.thread, counts.enumerate(h.memory.resolve(h.thread, pop32(h.thread))));
        return 0;
      },
    },
    {
      primary: 0xe0,
      secondary: 0x93,
      nativeAddress: 0x1400aadd0,
      name: 'SetDiagnosticCountFlags',
      execute: (h) => {
        const flags = pop32(h.thread),
          opcode = pop32(h.thread);
        push32(h.thread, counts.setFlags(opcode >>> 8, opcode & 255, flags));
        return 0;
      },
    },
    {
      primary: 0xe0,
      secondary: 0xc0,
      nativeAddress: 0x1400aaa90,
      name: 'SetAllocationDiagnostics',
      execute: (h) => {
        allocations.enabled = pop32(h.thread);
        return 0;
      },
    },
  ];
}
