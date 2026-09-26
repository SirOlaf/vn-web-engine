import {pop32, push32} from '../bp/state.js';
import type {BurikoDroppedFiles} from './dropped-files.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80DroppedFiles(drops: BurikoDroppedFiles): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x6c,
      nativeAddress: 0x1400e8440,
      name: 'AcceptDroppedFiles',
      execute: (h) => {
        drops.setEnabled(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x6d,
      nativeAddress: 0x1400e8410,
      name: 'ReadDroppedFilePath',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, drops.copyPath(output));
        return 0;
      },
    },
  ];
}
