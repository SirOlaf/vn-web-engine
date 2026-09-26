import {FileError} from '../../../platform/filesystem.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramFiles} from './program-files.js';
import {assertBurikoPathDomain} from './path-domain.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** E98E0 decodes source then destination and forwards MoveFileW's BOOL. */
export function createGroup80Move(files: BurikoProgramFiles): BurikoNativeSlotDefinition[] {
  const metadata = files.metadata;
  if (metadata === null) throw new Error('Buriko move requires the shared metadata owner');
  return [
    {
      primary: 0x80,
      secondary: 0x27,
      nativeAddress: 0x1400e98e0,
      name: 'MoveFile',
      execute: async (h): Promise<0> => {
        const sourcePointer = h.memory.resolve(h.thread, pop32(h.thread));
        const destinationPointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (sourcePointer === null || destinationPointer === null)
          throw new RangeError('Buriko MoveFile consumed a null native path');
        const source = files.text.decodeAuto(sourcePointer),
          destination = files.text.decodeAuto(destinationPointer);
        assertBurikoPathDomain(source);
        assertBurikoPathDomain(destination);
        let result = 1;
        try {
          await metadata.movePath(files.mountedPath(source), files.mountedPath(destination));
        } catch (error) {
          if (error instanceof FileError || error instanceof DOMException) result = 0;
          else throw error;
        }
        push32(h.thread, result);
        return 0;
      },
    },
  ];
}
