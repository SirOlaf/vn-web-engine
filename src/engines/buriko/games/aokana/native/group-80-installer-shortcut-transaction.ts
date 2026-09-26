import {pop32, push32} from '../bp/state.js';
import type {AokanaInstallerShortcutTransaction} from './installer-shortcut-transaction.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** E6350 reverses its six pointer and two DWORD pops for C82E0. */
export function createGroup80InstallerShortcutTransaction(
  shortcuts: AokanaInstallerShortcutTransaction,
): AokanaNativeSlotDefinition[] {
  return [{
    primary: 0x80,
    secondary: 0xf3,
    nativeAddress: 0x1400e6350,
    name: 'CreateInstallerShortcuts',
    execute: async ({thread, memory}): Promise<0> => {
      const createDesktop = pop32(thread),
        createPrograms = pop32(thread),
        subfolder = memory.resolve(thread, pop32(thread)),
        secondary = memory.resolve(thread, pop32(thread)),
        uninstaller = memory.resolve(thread, pop32(thread)),
        primary = memory.resolve(thread, pop32(thread)),
        executableName = memory.resolve(thread, pop32(thread)),
        executableFolder = memory.resolve(thread, pop32(thread));
      if (
        primary === null || secondary === null || uninstaller === null ||
        subfolder === null || executableName === null || executableFolder === null
      )
        throw new Error('Aokana installer shortcuts dereference a null path or filename');
      push32(thread, await shortcuts.create({
        executableFolder: textBytes(executableFolder, true).slice(),
        executableName: textBytes(executableName, true).slice(),
        mainShortcutName: textBytes(primary, true).slice(),
        uninstallerName: textBytes(uninstaller, true).slice(),
        uninstallerShortcutName: textBytes(secondary, true).slice(),
        programsSubfolder: textBytes(subfolder, true).slice(),
        createPrograms,
        createDesktop,
      }));
      return 0;
    },
  }];
}
