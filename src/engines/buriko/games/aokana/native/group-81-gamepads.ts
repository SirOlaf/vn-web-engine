import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeGamepads} from './gamepads.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Bank 81's two gamepad leaves use the single shared owner polled by the main loop. */
export function createGroup81Gamepads(
  gamepads: AokanaNativeGamepads,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x1b,
      nativeAddress: 0x1400ec320,
      name: 'SetGamepadMapping',
      execute: (h) => {
        const value = pop32(h.thread),
          index = pop32(h.thread);
        push32(h.thread, Number(gamepads.setMapping(index, value) === 0));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x1d,
      nativeAddress: 0x1400ec2d0,
      name: 'ReadGamepadState',
      execute: (h) => {
        const selector = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread)),
          state = gamepads.query(selector);
        if (state !== null) {
          if (destination === null)
            throw new TypeError('Aokana native gamepad state writes through a null output pointer');
          const view = pointerView(destination, 24);
          view.setInt32(0, state.x, true);
          view.setInt32(4, state.y, true);
          view.setInt32(8, state.z, true);
          view.setInt32(12, state.rz, true);
          view.setUint32(16, state.pov, true);
          view.setUint32(20, state.buttons, true);
        }
        push32(h.thread, Number(state !== null));
        return 0;
      },
    },
  ];
}
