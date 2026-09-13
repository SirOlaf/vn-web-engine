import {pop32, push32} from '../bp/state.js';
import {readAokanaFileTimestamps, writeAokanaFileTimestamps} from './file-timestamps.js';
import type {AokanaProgramFiles} from './program-files.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81FileTimestamps(
  files: AokanaProgramFiles,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x2c,
      nativeAddress: 0x1400ebe90,
      name: 'ReadFileTimestamps',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread)),
          write = h.memory.resolve(h.thread, pop32(h.thread)),
          access = h.memory.resolve(h.thread, pop32(h.thread)),
          creation = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await readAokanaFileTimestamps(files, creation, access, write, path));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x2d,
      nativeAddress: 0x1400ebe10,
      name: 'WriteFileTimestamps',
      execute: async (h): Promise<0> => {
        const write = h.memory.resolve(h.thread, pop32(h.thread)),
          access = h.memory.resolve(h.thread, pop32(h.thread)),
          creation = h.memory.resolve(h.thread, pop32(h.thread)),
          path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await writeAokanaFileTimestamps(files, path, creation, access, write));
        return 0;
      },
    },
  ];
}
