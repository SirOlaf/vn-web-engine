import {pop32, push32} from '../bp/state.js';
import type {BurikoFileSelectionService} from './file-selection.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {resolveBurikoAddressArray} from './vm-address-array.js';

/** Bank 81's ANSI file picker resolves both VM address arrays before entering its lower. */
export function createGroup81FileSelection(
  selection: BurikoFileSelectionService,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x38,
      nativeAddress: 0x1400eb8d0,
      name: 'SelectFile',
      execute: async (h): Promise<0> => {
        const mode = pop32(h.thread),
          initialDirectory = h.memory.resolve(h.thread, pop32(h.thread)),
          title = h.memory.resolve(h.thread, pop32(h.thread)),
          patternAddresses = h.memory.resolve(h.thread, pop32(h.thread)),
          descriptionAddresses = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          descriptions = resolveBurikoAddressArray(h.memory, h.thread, descriptionAddresses, count),
          patterns = resolveBurikoAddressArray(h.memory, h.thread, patternAddresses, count);
        push32(
          h.thread,
          await selection.select(
            output,
            count,
            descriptions,
            patterns,
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
