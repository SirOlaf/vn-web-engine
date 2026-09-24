import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaPropertyEditors} from './property-editor.js';
import {createAokanaObjectPropertyTab} from './object-property-editor.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroupE0ObjectProperties(
  editors: AokanaPropertyEditors,
  manager: AokanaDisplayManager,
): AokanaNativeSlotDefinition[] {
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
        const status = createAokanaObjectPropertyTab(
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
