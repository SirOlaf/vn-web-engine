import {pop32, push32} from '../bp/state.js';
import type {BurikoStringLists} from './string-lists.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80StringLists(lists: BurikoStringLists): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xd8,
      nativeAddress: 0x1400e6ed0,
      name: 'ResetStringLists',
      execute: () => {
        lists.reset(1);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xd9,
      nativeAddress: 0x1400e6ea0,
      name: 'ReadStringListCount',
      execute: (h) => {
        push32(h.thread, lists.count(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xda,
      nativeAddress: 0x1400e6e50,
      name: 'ReplaceStringList',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, lists.replace(id, count, source));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xdb,
      nativeAddress: 0x1400e6e00,
      name: 'ReadStringListBytes',
      execute: (h) => {
        const id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, lists.copyAll(output, id));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xdc,
      nativeAddress: 0x1400e6dc0,
      name: 'AppendStringListEntry',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread);
        push32(h.thread, lists.append(id, source));
        return 0;
      },
    },
    ...(
      [
        [0xdd, 0x1400e6d60, 'ReadStringListEntry'],
        [0xde, 0x1400e6d00, 'ReadStringListEntryLength'],
      ] as const
    ).map(([secondary, nativeAddress, name]): BurikoNativeSlotDefinition => ({
      primary: 0x80,
      secondary,
      nativeAddress,
      name,
      execute: (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          lists.read(
            secondary === 0xdd ? output : null,
            secondary === 0xde ? output : null,
            id,
            index,
          ),
        );
        return 0;
      },
    })),
  ];
}
