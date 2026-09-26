import {pop32, push32} from '../bp/state.js';
import type {AokanaDriveTypeHost, AokanaProgramMedia} from './program-files.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81Drives(
  media: AokanaProgramMedia,
  host: AokanaDriveTypeHost,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x36,
      nativeAddress: 0x1400eba50,
      name: 'EnumerateDriveTypes',
      execute: (h) => {
        const output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, media.writeDriveClassifications(host, output));
        return 0;
      },
    },
  ];
}
