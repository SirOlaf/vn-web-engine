import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {textBytes} from './text.js';
import {loadBwefPairs} from './bwef.js';

export function createGroupC0Bwef(resources: BurikoProgramResources): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xc0,
      secondary: 0xf0,
      nativeAddress: 0x1400d02e0,
      name: 'ReadBwefPairs',
      execute: async (h): Promise<0> => {
        const addition = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread)),
          archive = h.memory.resolve(h.thread, pop32(h.thread)),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        if (name === null) throw new Error('Buriko BWEF loader dereferences a null resource name');
        push32(
          h.thread,
          await loadBwefPairs(
            resources,
            output,
            count,
            archive === null ? null : () => textBytes(archive),
            textBytes(name),
            addition,
          ),
        );
        return 0;
      },
    },
  ];
}
