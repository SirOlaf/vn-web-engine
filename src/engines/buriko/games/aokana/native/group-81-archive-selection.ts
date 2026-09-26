import {pop32, push32} from '../bp/state.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaSelectionDialog} from './selection-dialog.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Bank 81's archive-entry picker shares the archive cache and native list-modal owner. */
export function createGroup81ArchiveSelection(
  resources: AokanaProgramResources,
  selection: AokanaSelectionDialog,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x3b,
      nativeAddress: 0x1400eb780,
      name: 'SelectArchiveEntry',
      execute: async (h): Promise<0> => {
        const archive = h.memory.resolve(h.thread, pop32(h.thread)),
          prompt = h.memory.resolve(h.thread, pop32(h.thread)),
          title = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const ownedArchive = textBytes(archive!, true).slice();
        push32(
          h.thread,
          await resources.selectArchiveEntry(selection, output, title, prompt, ownedArchive),
        );
        return 0;
      },
    },
  ];
}
