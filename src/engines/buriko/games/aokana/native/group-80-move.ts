import {FileError} from '../../../../../platform/filesystem.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaProgramFiles} from './program-files.js';
import {assertAokanaPathDomain} from './path-domain.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** E98E0 decodes source then destination and forwards MoveFileW's BOOL. */
export function createGroup80Move(files: AokanaProgramFiles): AokanaNativeSlotDefinition[] {
  const metadata = files.metadata;
  if (metadata === null) throw new Error('Aokana move requires the shared metadata owner');
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
          throw new RangeError('Aokana MoveFile consumed a null native path');
        const source = files.text.decodeAuto(sourcePointer),
          destination = files.text.decodeAuto(destinationPointer);
        assertAokanaPathDomain(source);
        assertAokanaPathDomain(destination);
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
