import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeRecordBuffers} from './record-buffers.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81Records(
  records: BurikoNativeRecordBuffers,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xd0,
      nativeAddress: 0x1400eac80,
      name: 'CreateRecordSet',
      execute: (h) => {
        const capacity = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, records.create(destination, capacity));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xd1,
      nativeAddress: 0x1400eac50,
      name: 'DestroyRecordSet',
      execute: (h) => {
        push32(h.thread, records.destroy(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xd2,
      nativeAddress: 0x1400eabc0,
      name: 'WriteRecord',
      execute: (h) => {
        const size = pop32(h.thread),
          source = h.memory.resolve(h.thread, pop32(h.thread)),
          index = pop32(h.thread),
          id = pop32(h.thread),
          indexOutput = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, records.write(indexOutput, id, index, source, size));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xd3,
      nativeAddress: 0x1400eab80,
      name: 'RemoveRecord',
      execute: (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, records.remove(id, index));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xd4,
      nativeAddress: 0x1400eab00,
      name: 'ReadRecord',
      execute: (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread),
          sizeOutput = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, records.read(destination, sizeOutput, id, index));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xd5,
      nativeAddress: 0x1400eaaa0,
      name: 'EnumerateRecords',
      execute: (h) => {
        const id = pop32(h.thread),
          countOutput = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, records.enumerate(destination, countOutput, id));
        return 0;
      },
    },
  ];
}

/** The four native callees each consist of MOV EAX,80000004; RET in this executable. */
export const group81Disabled: BurikoNativeSlotDefinition[] = [
  ...[
    [0x8c, 0x1400eb080],
    [0x8e, 0x1400eaf80],
  ].map(([secondary, nativeAddress]) => ({
    primary: 0x81,
    secondary: secondary!,
    nativeAddress: nativeAddress!,
    name: `NativeDisabled${secondary!.toString(16).toUpperCase()}`,
    execute: (h: Parameters<BurikoNativeSlotDefinition['execute']>[0]) => {
      pop32(h.thread);
      h.memory.resolve(h.thread, pop32(h.thread));
      push32(h.thread, 1);
      return 0 as const;
    },
  })),
  ...[
    [0x8d, 0x1400eb000],
    [0x8f, 0x1400eaf00],
  ].map(([secondary, nativeAddress]) => ({
    primary: 0x81,
    secondary: secondary!,
    nativeAddress: nativeAddress!,
    name: `NativeDisabled${secondary!.toString(16).toUpperCase()}`,
    execute: (h: Parameters<BurikoNativeSlotDefinition['execute']>[0]) => {
      h.memory.resolve(h.thread, pop32(h.thread));
      h.memory.resolve(h.thread, pop32(h.thread));
      push32(h.thread, 1);
      return 0 as const;
    },
  })),
];
