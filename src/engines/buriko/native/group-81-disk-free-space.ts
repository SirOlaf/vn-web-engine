import {pop32, push32} from '../bp/state.js';
import type {BurikoDiskFreeSpaceHost, BurikoProgramFiles} from './program-files.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81DiskFreeSpace(
  files: BurikoProgramFiles,
  host: BurikoDiskFreeSpaceHost,
): BurikoNativeSlotDefinition[] {
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
