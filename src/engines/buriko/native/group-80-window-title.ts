import {pop32} from '../bp/state.js';
import type {BurikoBrowserMainWindow} from './browser-main-window.js';
import type {BurikoEngineDialogs} from './engine-dialogs.js';
import type {BurikoChildWindows} from './child-windows.js';
import type {BurikoPropertyEditors} from './property-editor.js';
import type {BurikoNativeText} from './text.js';
import type {BurikoWindowTitle} from './window-title.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80WindowTitle(
  title: BurikoWindowTitle,
  text: BurikoNativeText,
  host: BurikoBrowserMainWindow,
  dialogs: BurikoEngineDialogs,
  children: BurikoChildWindows,
  properties: BurikoPropertyEditors,
): BurikoNativeSlotDefinition[] {
  title.validateConsumers(dialogs, children, properties);
  return [
    {
      primary: 0x80,
      secondary: 0x66,
      nativeAddress: 0x1400e8550,
      name: 'SetWindowTitle',
      execute: (context) => {
        title.set(context.memory.resolve(context.thread, pop32(context.thread)), text, host);
        return 0;
      },
    },
  ];
}
