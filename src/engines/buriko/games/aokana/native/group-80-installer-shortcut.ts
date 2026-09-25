import {pop32, push32} from '../bp/state.js';
import type {AokanaShellShortcuts} from './shell-shortcuts.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** E6100 pops target, filename, subfolder and calls C8650 with null arguments. */
export function createGroup80InstallerShortcut(
  shortcuts: AokanaShellShortcuts,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xf7,
      nativeAddress: 0x1400e6100,
      name: 'CreateInstallerShortcut',
      execute: async ({thread, memory}): Promise<0> => {
        const target = memory.resolve(thread, pop32(thread)),
          filename = memory.resolve(thread, pop32(thread)),
          subdirectory = memory.resolve(thread, pop32(thread));
        if (target === null || filename === null)
          throw new Error('Aokana installer shortcut dereferences a null target or filename');
        const targetBytes = textBytes(target, true).slice(),
          filenameBytes = textBytes(filename, true).slice(),
          subdirectoryBytes = subdirectory === null ? null : textBytes(subdirectory, true).slice();
        push32(thread, await shortcuts.create(subdirectoryBytes, filenameBytes, targetBytes, null));
        return 0;
      },
    },
  ];
}
