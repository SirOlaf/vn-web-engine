import {pop32} from '../bp/state.js';
import type {AokanaPrintScreenHotkeys} from './print-screen-hotkeys.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81Hotkeys(
  hotkeys: AokanaPrintScreenHotkeys,
): AokanaNativeSlotDefinition[] {
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
