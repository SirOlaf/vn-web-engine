import {pop32, push32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** E3F70 -> B5D40 -> 07ED70, concrete pool destruction selected by native category. */
export function createGroup92ObjectLifecycle(
  manager: BurikoDisplayManager,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x31,
      nativeAddress: 0x1400e3f70,
      name: 'DestroyObject',
      execute: (h) => {
        const handle = pop32(h.thread);
        push32(h.thread, manager.destroyObject(handle) === 0 ? 1 : 0);
        return 0;
      },
    },
  ];
}
