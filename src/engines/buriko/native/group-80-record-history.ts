import {pop32, push32} from '../bp/state.js';
import type {BurikoRecordHistories} from './record-history.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';
export function createGroup80RecordHistory(
  histories: BurikoRecordHistories,
): BurikoNativeSlotDefinition[] {
  const pointer = (h: BurikoBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  return [
    {
      primary: 0x80,
      secondary: 0x98,
      nativeAddress: 0x1400e7780,
      name: 'CreateRecordHistory',
      execute: (h) => {
        const size = pop32(h.thread),
          capacity = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, histories.create(output, capacity, size));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x99,
      nativeAddress: 0x1400e7750,
      name: 'RemoveRecordHistory',
      execute: (h) => {
        push32(h.thread, histories.remove(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x9a,
      nativeAddress: 0x1400e7700,
      name: 'ReadRecordHistoryCount',
      execute: (h) => {
        const id = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, histories.count(output, id));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x9c,
      nativeAddress: 0x1400e76c0,
      name: 'AppendRecordHistory',
      execute: (h) => {
        const source = pointer(h),
          id = pop32(h.thread);
        push32(h.thread, histories.append(id, source));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x9d,
      nativeAddress: 0x1400e7660,
      name: 'ReadRecordHistory',
      execute: (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread),
          output = pointer(h);
        push32(h.thread, histories.read(output, id, index));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x9e,
      nativeAddress: 0x1400e7610,
      name: 'RemoveRecordHistoryRange',
      execute: (h) => {
        const count = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, histories.removeRange(id, index, count));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x9f,
      nativeAddress: 0x1400e75d0,
      name: 'SetRecordHistoryMode',
      execute: (h) => {
        const mode = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, histories.setMode(id, mode));
        return 0;
      },
    },
  ];
}
