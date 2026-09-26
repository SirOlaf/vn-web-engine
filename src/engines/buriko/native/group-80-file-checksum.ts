import {pop32, push32} from '../bp/state.js';
import type {BurikoFileChecksum} from './file-checksum.js';
import type {BurikoNativeSlotDefinition} from './types.js';
export function createGroup80FileChecksum(
  checksum: BurikoFileChecksum,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xe9,
      nativeAddress: 0x1400e69a0,
      name: 'ReadFileChecksum',
      execute: async (h): Promise<0> => {
        const name = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await checksum.calculate(output, name));
        return 0;
      },
    },
  ];
}
