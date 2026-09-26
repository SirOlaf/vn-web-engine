import {pop32, push32} from '../bp/state.js';
import type {BurikoFolderSelectionService} from './folder-selection.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Bank 81's shared folder chooser owns both VM strings before awaiting its host. */
export function createGroup81FolderSelection(
  selection: BurikoFolderSelectionService,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x3a,
      nativeAddress: 0x1400eb800,
      name: 'SelectFolder',
      execute: async (h): Promise<0> => {
        const initialPath = h.memory.resolve(h.thread, pop32(h.thread)),
          title = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          ownedTitle = title === null ? null : textBytes(title, true).slice(),
          ownedInitialPath = initialPath === null ? null : textBytes(initialPath, true).slice();
        push32(h.thread, await selection.select(output, ownedTitle, ownedInitialPath));
        return 0;
      },
    },
  ];
}
