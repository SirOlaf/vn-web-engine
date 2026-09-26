import {pop32} from '../bp/state.js';
import type {BurikoExternalMutexName} from './external-mutex-name.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 80:EA writes the same ANSI name later read by the external-process mutex wait. */
export function createGroup80ExternalMutexName(
  name: BurikoExternalMutexName,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xea,
      nativeAddress: 0x1400e6980,
      name: 'SetUninstallerMutexName',
      execute: ({thread, memory}) => {
        const pointer = memory.resolve(thread, pop32(thread));
        if (pointer === null) throw new Error('Buriko uninstaller mutex name pointer is null');
        name.setUninstallerName(textBytes(pointer));
        return 0;
      },
    },
  ];
}
