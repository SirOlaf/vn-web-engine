import {pop32, push32} from '../bp/state.js';
import type {BurikoFileSelectionService} from './file-selection.js';
import type {BurikoNativeSlotDefinition} from './types.js';
export function createGroup80FileSelection(
  selection: BurikoFileSelectionService,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x3b,
      nativeAddress: 0x1400e90e0,
      name: 'SelectFileExtension',
      execute: async (h): Promise<0> => {
        const mode = pop32(h.thread),
          initialDirectory = h.memory.resolve(h.thread, pop32(h.thread)),
          title = h.memory.resolve(h.thread, pop32(h.thread)),
          extension = h.memory.resolve(h.thread, pop32(h.thread)),
          description = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          await selection.selectExtension(
            output,
            description,
            extension,
            title,
            initialDirectory,
            mode,
          ),
        );
        return 0;
      },
    },
  ];
}
