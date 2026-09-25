import {pop32} from '../bp/state.js';
import type {AokanaMainWindowShowState} from './main-window-show-state.js';
import type {AokanaMainWindowTransitions} from './main-window-transitions.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** 80:64/65 share the actual scoped HWND, input state and awaited message dispatcher. */
export function createGroup80MainShow(
  show: AokanaMainWindowShowState,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x64,
      nativeAddress: 0x1400e85e0,
      name: 'SetMainWindowShowState',
      execute: async ({thread}): Promise<0> => {
        await show.setShowState(pop32(thread));
        return 0;
      },
    },
  ];
}

/** CloseWindow's BOOL is ignored before the distinct key-clear and script latch tail. */
export function createGroup80MainMinimize(
  show: AokanaMainWindowShowState,
  transitions: AokanaMainWindowTransitions,
): AokanaNativeSlotDefinition[] {
  if (
    transitions.host !== show.host || transitions.input !== show.input ||
    transitions.dispatcher !== show.dispatcher
  )
    throw new Error('Aokana main minimize requires one window and queued dispatcher');
  return [
    {
      primary: 0x80,
      secondary: 0x65,
      nativeAddress: 0x1400e85b0,
      name: 'MinimizeMainWindow',
      execute: async (): Promise<0> => {
        await transitions.minimize();
        show.input.clearTransientKeys();
        show.input.scriptMinimizeLatch = 1;
        return 0;
      },
    },
  ];
}
