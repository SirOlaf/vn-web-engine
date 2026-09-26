import {pop32, push32} from '../bp/state.js';
import type {BurikoDriveGeometryHost, BurikoProgramFiles} from './program-files.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Bank 81's direct drive-file read uses mounted files plus an explicit sector profile. */
export function createGroup81DriveFileRead(
  files: BurikoProgramFiles,
  host: BurikoDriveGeometryHost,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x32,
      nativeAddress: 0x1400ebb80,
      name: 'ReadDriveFile',
      execute: async (h): Promise<0> => {
        const requestedLength = pop32(h.thread),
          path = h.memory.resolve(h.thread, pop32(h.thread)),
          outputSize = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        const ownedPath = textBytes(path!, true).slice();
        push32(
          h.thread,
          await files.readDriveFile(host, destination, outputSize, ownedPath, requestedLength),
        );
        return 0;
      },
    },
  ];
}
