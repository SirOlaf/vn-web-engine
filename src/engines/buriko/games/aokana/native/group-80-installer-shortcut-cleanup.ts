import {pop32} from '../bp/state.js';
import type {AokanaInstallerShortcutCleanup} from './installer-shortcut-cleanup.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** E6160 pops flag, subfolder, companion, then primary and pushes no result. */
export function createGroup80InstallerShortcutCleanup(
  cleanup: AokanaInstallerShortcutCleanup,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xf6,
      nativeAddress: 0x1400e6160,
      name: 'RemoveInstallerShortcuts',
      execute: async ({thread, memory}): Promise<0> => {
        const removeFolder = pop32(thread),
          third = memory.resolve(thread, pop32(thread)),
          second = memory.resolve(thread, pop32(thread)),
          first = memory.resolve(thread, pop32(thread));
        await cleanup.remove(first, second, third, removeFolder);
        return 0;
      },
    },
  ];
}
