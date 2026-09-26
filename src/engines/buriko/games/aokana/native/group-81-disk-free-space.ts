import {pop32, push32} from '../bp/state.js';
import type {AokanaDiskFreeSpaceHost, AokanaProgramFiles} from './program-files.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81DiskFreeSpace(
  files: AokanaProgramFiles,
  host: AokanaDiskFreeSpaceHost,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x37,
      nativeAddress: 0x1400eba00,
      name: 'ReadDiskFreeMegabytes',
      execute: (h) => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, files.readDiskFreeMegabytes(host, path!, output));
        return 0;
      },
    },
  ];
}
