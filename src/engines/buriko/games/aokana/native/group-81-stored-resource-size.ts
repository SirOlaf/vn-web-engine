import {pop32, push32} from '../bp/state.js';
import type {AokanaResourceRanges} from './resource-ranges.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Bank 81's stored-size query shares the raw range reader used by queued loads. */
export function createGroup81StoredResourceSize(
  ranges: AokanaResourceRanges,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x35,
      nativeAddress: 0x1400eba80,
      name: 'ReadStoredResourceSize',
      execute: async (h): Promise<0> => {
        const name = h.memory.resolve(h.thread, pop32(h.thread));
        const archive = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          await ranges.size(
            archive === null ? null : textBytes(archive).slice(),
            textBytes(name!).slice(),
          ),
        );
        return 0;
      },
    },
  ];
}
