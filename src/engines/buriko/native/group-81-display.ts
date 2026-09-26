import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoNativeDisplayState} from './display-state.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81Display(
  display: BurikoNativeDisplayState,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x60,
      nativeAddress: 0x1400eb420,
      name: 'SetSizePreset',
      execute: (h) => {
        const height = pop32(h.thread),
          width = pop32(h.thread),
          index = pop32(h.thread);
        push32(h.thread, display.setSizePreset(index, width, height));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x61,
      nativeAddress: 0x1400eb3f0,
      name: 'ReadEffectiveDisplayMode',
      execute: (h) => {
        push32(h.thread, display.effectiveDisplayMode());
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x62,
      nativeAddress: 0x1400eb3c0,
      name: 'SetDisplayFlag',
      execute: (h) => {
        const value = pop32(h.thread);
        if (value < 2) display.displayFlag = value;
        push32(h.thread, Number(value < 2));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x63,
      nativeAddress: 0x1400eb390,
      name: 'SetDisplayMode',
      execute: (h) => {
        const mode = pop32(h.thread);
        if (mode < 3) display.displayMode = mode;
        push32(h.thread, Number(mode < 3));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x65,
      nativeAddress: 0x1400eb330,
      name: 'SetWindowPositionLock',
      execute: (h) => {
        display.positionLock = pop32(h.thread);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x67,
      nativeAddress: 0x1400eb2f0,
      name: 'ReadRequestedClientSize',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        if (destination === null) throw new Error('Buriko native client-size null output');
        const view = pointerView(destination, 8);
        view.setUint32(0, display.requestedWidth, true);
        view.setUint32(4, display.requestedHeight, true);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x6c,
      nativeAddress: 0x1400eb210,
      name: 'SetAspectSize',
      execute: (h) => {
        const height = pop32(h.thread),
          width = pop32(h.thread);
        push32(h.thread, Number(display.setAspectSize(width, height) === 0));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x09,
      nativeAddress: 0x1400ea190,
      name: 'LastPresentMilliseconds',
      execute: (h) => {
        push32(h.thread, display.lastPresentMilliseconds);
        return 0;
      },
    },
  ];
}
