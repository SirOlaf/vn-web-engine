import {pop32, push32} from '../bp/state.js';
import type {AokanaProgramResources} from './program-resources.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Bank 81's archive release mutates the shared linked archive cache. */
export function createGroup81ArchiveRelease(
  resources: AokanaProgramResources,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x3c,
      nativeAddress: 0x1400eb750,
      name: 'ReleaseArchive',
      execute: async (h): Promise<0> => {
        const archive = h.memory.resolve(h.thread, pop32(h.thread));
        const ownedArchive = textBytes(archive!, true).slice();
        push32(h.thread, await resources.releaseArchive(ownedArchive));
        return 0;
      },
    },
  ];
}
