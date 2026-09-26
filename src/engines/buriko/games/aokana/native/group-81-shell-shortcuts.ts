import {pop32, push32} from '../bp/state.js';
import type {AokanaShellShortcuts} from './shell-shortcuts.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81ShellShortcuts(
  shortcuts: AokanaShellShortcuts,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xf7,
      nativeAddress: 0x1400ea400,
      name: 'CreateShellShortcut',
      execute: async (h): Promise<0> => {
        const argumentsPointer = h.memory.resolve(h.thread, pop32(h.thread));
        const targetPointer = h.memory.resolve(h.thread, pop32(h.thread));
        const filenamePointer = h.memory.resolve(h.thread, pop32(h.thread));
        const subdirectoryPointer = h.memory.resolve(h.thread, pop32(h.thread));
        const arguments_ =
          argumentsPointer === null ? null : textBytes(argumentsPointer, true).slice();
        const target = textBytes(targetPointer!, true).slice();
        const filename = textBytes(filenamePointer!, true).slice();
        const subdirectory =
          subdirectoryPointer === null ? null : textBytes(subdirectoryPointer, true).slice();
        push32(h.thread, await shortcuts.create(subdirectory, filename, target, arguments_));
        return 0;
      },
    },
  ];
}
