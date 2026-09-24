import {pop32, push32} from '../bp/state.js';
import type {AokanaSecondaryMediaDiscovery} from './secondary-media.js';
import type {AokanaNativeSlotDefinition} from './types.js';
export function createGroup80SecondaryMedia(
  discovery: AokanaSecondaryMediaDiscovery,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x3f,
      nativeAddress: 0x1400e8f00,
      name: 'DiscoverSecondaryMedia',
      execute: async (h): Promise<0> => {
        const retry = pop32(h.thread),
          message = h.memory.resolve(h.thread, pop32(h.thread)),
          title = h.memory.resolve(h.thread, pop32(h.thread)),
          marker = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await discovery.select(marker, title, message, retry));
        return 0;
      },
    },
  ];
}
