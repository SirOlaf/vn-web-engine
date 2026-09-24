import {pop32} from '../bp/state.js';
import type {AokanaBrowserMainWindow} from './browser-main-window.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import type {AokanaChildWindows} from './child-windows.js';
import type {AokanaPropertyEditors} from './property-editor.js';
import type {AokanaNativeText} from './text.js';
import type {AokanaWindowTitle} from './window-title.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup80WindowTitle(
  title: AokanaWindowTitle,
  text: AokanaNativeText,
  host: AokanaBrowserMainWindow,
  dialogs: AokanaEngineDialogs,
  children: AokanaChildWindows,
  properties: AokanaPropertyEditors,
): AokanaNativeSlotDefinition[] {
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
