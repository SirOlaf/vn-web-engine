import {pop32, push32} from '../bp/state.js';
import type {BurikoSyntheticMouse} from './synthetic-mouse.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Bank 81:1E preserves the raw zero/one lower result on the VM operand stack. */
export function createGroup81SyntheticMouse(
  mouse: BurikoSyntheticMouse,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x1e,
      nativeAddress: 0x1400ec2a0,
      name: 'SynthesizeMouseClick',
      execute: (h) => {
        push32(h.thread, mouse.click(pop32(h.thread)));
        return 0;
      },
    },
  ];
}
