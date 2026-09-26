import {pop32} from '../bp/state.js';
import type {BurikoBrowserMainWindow} from './browser-main-window.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 80:68/69 use the one bound main-window menu and posted-message owner. */
export function createGroup80MainClose(
  host: BurikoBrowserMainWindow,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x68,
      nativeAddress: 0x1400e84e0,
      name: 'SetMainClosePolicy',
      execute: ({thread}) => {
        host.setClosePolicy(pop32(thread));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x69,
      nativeAddress: 0x1400e84b0,
      name: 'PostMainClose',
      execute: () => {
        host.postClose();
        return 0;
      },
    },
  ];
}
