import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramResources} from './program-resources.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81ArchiveNames(
  resources: BurikoProgramResources,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x39,
      nativeAddress: 0x1400eb870,
      name: 'EnumerateArchiveNames',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        const outputValue = h.memory.resolve(h.thread, pop32(h.thread));
        const packedNames = h.memory.resolve(h.thread, pop32(h.thread));
        const ownedPath = textBytes(path!, true).slice();
        push32(
          h.thread,
          await resources.enumerateArchiveNames(packedNames, outputValue!, ownedPath),
        );
        return 0;
      },
    },
  ];
}
