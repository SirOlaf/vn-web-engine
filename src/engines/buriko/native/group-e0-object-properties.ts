import {pop32, push32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoPropertyEditors} from './property-editor.js';
import {createBurikoObjectPropertyTab} from './object-property-editor.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroupE0ObjectProperties(
  editors: BurikoPropertyEditors,
  manager: BurikoDisplayManager,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x20,
      nativeAddress: 0x1400ab6e0,
      name: 'CreateObjectPropertyTab',
      execute: (h) => {
        const label = h.memory.resolve(h.thread, pop32(h.thread)),
          handle = pop32(h.thread),
          editor = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const status = createBurikoObjectPropertyTab(
          editors,
          manager,
          output,
          editor,
          handle,
          label,
        );
        push32(
          h.thread,
          status === 0
            ? 0
            : status === 0x80000007
              ? 1
              : status === 0x80000010
                ? 8
                : status === 0x80000014
                  ? 7
                  : 0xffffffff,
        );
        return 0;
      },
    },
  ];
}
