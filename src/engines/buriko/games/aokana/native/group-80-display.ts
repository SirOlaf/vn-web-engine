import {push32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** 80 0B: 0ea110 -> 07fd70 -> 06eb00 reads the renderer's +90 strip pixel budget. */
export function createGroup80Display(manager: AokanaDisplayManager): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x0b,
      nativeAddress: 0x1400ea110,
      name: 'ReadRenderPixelBudget',
      execute: (h) => {
        push32(h.thread, manager.renderPixelBudget);
        return 0;
      },
    },
  ];
}
