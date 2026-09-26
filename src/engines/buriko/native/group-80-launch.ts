import {pop32, push32} from '../bp/state.js';
import type {BurikoLaunchSelection} from './launch-selection.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** The restart selector and launcher query share the startup launch owner. */
export function createGroup80Launch(launch: BurikoLaunchSelection): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x6b,
      nativeAddress: 0x1400e8460,
      name: 'SelectRestartProgram',
      execute: async ({thread, memory}): Promise<5> => {
        const module = memory.resolve(thread, pop32(thread));
        const path = memory.resolve(thread, pop32(thread));
        await launch.selectPathAndModule(textBytes(path!), textBytes(module!));
        return 5;
      },
    },
    {
      primary: 0x80,
      secondary: 0xfd,
      nativeAddress: 0x1400e5f00,
      name: 'IsLauncher',
      execute: ({thread}) => {
        push32(thread, launch.launcherFlag);
        return 0;
      },
    },
  ];
}
