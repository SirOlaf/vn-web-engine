import {pop32} from '../bp/state.js';
import type {BurikoPrintScreenHotkeys} from './print-screen-hotkeys.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81Hotkeys(
  hotkeys: BurikoPrintScreenHotkeys,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x69,
      nativeAddress: 0x1400eb2a0,
      name: 'SetPrintScreenHotkeys',
      execute: (h) => {
        hotkeys.setEnabled(pop32(h.thread));
        return 0;
      },
    },
  ];
}
