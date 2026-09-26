import {pop32, push32} from '../bp/state.js';
import type {BurikoResourceFilePresence} from './resource-file-presence.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80FilePresence(
  presence: BurikoResourceFilePresence,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x3c,
      nativeAddress: 0x1400e9080,
      name: 'WaitForResourceFile',
      execute: async ({thread, memory}): Promise<0> => {
        const message = memory.resolve(thread, pop32(thread)),
          title = memory.resolve(thread, pop32(thread)),
          filename = memory.resolve(thread, pop32(thread));
        push32(thread, await presence.wait(filename, title, message));
        return 0;
      },
    },
  ];
}
