import {pop32, push32} from '../bp/state.js';
import {copyBurikoBitmapGroupDescription} from './bitmap-group-description.js';
import type {BurikoDisplayManager} from './display-manager.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import {drawBurikoWindowBitmapGroups} from './window-bitmap-groups.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup90WindowBitmapGroups(
  manager: BurikoDisplayManager,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xb7,
      nativeAddress: 0x1400d7d00,
      name: 'DrawWindowBitmapGroups',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          handle = pop32(h.thread),
          window = manager.find('window', handle);
        if (window === null) {
          push32(h.thread, 1);
          return 0;
        }
        if (!(window instanceof BurikoWindowDisplayObject))
          throw new Error('Buriko bitmap groups require the actual Window owner');
        const copied = copyBurikoBitmapGroupDescription(source, h.memory, h.thread);
        let status: number = copied.result;
        if (copied.result === 0) {
          const result = drawBurikoWindowBitmapGroups(window, copied.description);
          status = result === 0x80000001 ? 2 : result === 0x80000002 ? 3 : 0;
        }
        push32(h.thread, status);
        return 0;
      },
    },
  ];
}
