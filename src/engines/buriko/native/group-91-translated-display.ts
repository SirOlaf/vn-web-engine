import {pop32, push32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** E2AC0/E2A90 use the existing renderer and the independent global origin owner. */
export function createGroup91TranslatedDisplay(
  manager: BurikoDisplayManager,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x05,
      nativeAddress: 0x1400e2ac0,
      name: 'RenderTranslatedDisplayBitmap',
      execute: (context) => {
        const maximumLayer = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          surface = pop32(context.thread);
        push32(
          context.thread,
          manager.renderTranslatedDisplayBitmap(surface, -x | 0, -y | 0, maximumLayer),
        );
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x06,
      nativeAddress: 0x1400e2a90,
      name: 'SetDisplayGlobalOrigin',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread);
        manager.setOrigin(x, y);
        return 0;
      },
    },
  ];
}
