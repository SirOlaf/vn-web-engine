import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup91SpriteMask(
  manager: AokanaDisplayManager,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x55,
      nativeAddress: 0x1400e0c20,
      name: 'SetSpriteDynamicMask',
      execute: (h) => {
        const mask = pop32(h.thread),
          handle = pop32(h.thread);
        push32(h.thread, manager.setSpriteDynamicMask(handle, mask));
        return 0;
      },
    },
  ];
}
