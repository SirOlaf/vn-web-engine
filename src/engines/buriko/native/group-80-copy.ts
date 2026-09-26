import {FileError} from '../../../platform/filesystem.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramFiles} from './program-files.js';
import {assertBurikoPathDomain} from './path-domain.js';
import type {BurikoNativeSlotDefinition} from './types.js';
const apiFailure = (error: unknown): boolean =>
  error instanceof FileError || error instanceof DOMException;
/** E9590 clears destination READONLY before CopyFileW(FALSE); that mutation is independent. */
export function createGroup80Copy(files: BurikoProgramFiles): BurikoNativeSlotDefinition[] {
  const metadata = files.metadata;
  if (metadata === null) throw new Error('Buriko copy requires the shared metadata owner');
  return [
    {
      primary: 0x80,
      secondary: 0x2f,
      nativeAddress: 0x1400e9590,
      name: 'CopyFile',
      execute: async (h): Promise<0> => {
        const sourcePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          destinationPointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (sourcePointer === null || destinationPointer === null)
          throw new RangeError('Buriko CopyFile consumed a null native path');
        const source = files.text.decodeAuto(sourcePointer),
          destination = files.text.decodeAuto(destinationPointer);
        assertBurikoPathDomain(source);
        assertBurikoPathDomain(destination);
        // GetFileAttributes/SetFileAttributes operate before source path resolution or existence checks.
        try {
          const destinationPath = files.mountedPath(destination),
            attributes = await metadata.getAttributes(destinationPath);
          if (attributes === null)
            throw new Error('Buriko copy lacks imported destination attribute metadata');
          try {
            await metadata.setAttributes(destinationPath, attributes & 0xfffffffe);
          } catch (error) {
            if (!apiFailure(error)) throw error;
          }
        } catch (error) {
          if (!apiFailure(error)) throw error;
        }
        let result = 1;
        try {
          await metadata.copyPath(files.mountedPath(source), files.mountedPath(destination));
        } catch (error) {
          if (apiFailure(error)) result = 0;
          else throw error;
        }
        push32(h.thread, result);
        return 0;
      },
    },
  ];
}
