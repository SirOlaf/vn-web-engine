import {pop32, push32} from '../bp/state.js';
import type {BurikoNamedValueMaps} from './named-value-maps.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80NamedMaps(maps: BurikoNamedValueMaps): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xd0,
      nativeAddress: 0x1400e7040,
      name: 'CreateNamedValueMap',
      execute: (h) => {
        const width = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, maps.create(output, width));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xd1,
      nativeAddress: 0x1400e7010,
      name: 'DestroyNamedValueMap',
      execute: (h) => {
        push32(h.thread, maps.destroy(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xd2,
      nativeAddress: 0x1400e6fb0,
      name: 'WriteNamedValue',
      execute: (h) => {
        const value = h.memory.resolve(h.thread, pop32(h.thread)),
          key = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread);
        push32(h.thread, maps.write(id, key, value));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xd3,
      nativeAddress: 0x1400e6f70,
      name: 'RemoveNamedValue',
      execute: (h) => {
        const key = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread);
        push32(h.thread, maps.remove(id, key));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xd4,
      nativeAddress: 0x1400e6ef0,
      name: 'ReadNamedValue',
      execute: (h) => {
        const index = pop32(h.thread),
          key = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, maps.read(output, id, key, index));
        return 0;
      },
    },
  ];
}
