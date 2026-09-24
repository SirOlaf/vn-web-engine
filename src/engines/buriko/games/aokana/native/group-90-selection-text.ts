import {pointerView} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {drawAokanaSelectionText} from './selection-text.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
import {resolveAokanaAddressArray} from './vm-address-array.js';

/** Immediate native selection rendering and its actual per-Window color owner. */
export function createGroup90SelectionText(
  windows: AokanaWindowDisplayState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      windows.textLayout.text.encodeWide(message, 0),
    );
  return [
    {
      primary: 0x90,
      secondary: 0xa1,
      nativeAddress: 0x1400d85c0,
      name: 'DrawSelectionItems',
      execute: (context) => {
        const color = pop32(context.thread),
          centered = pop32(context.thread),
          columns = pop32(context.thread),
          addresses = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          handle = pop32(context.thread);
        if ((count - 1) >>> 0 > 15)
          return fatal(context, `無効な項目数 [ ${count | 0} ] が指定されました`);
        if (columns >>> 0 >= 17)
          return fatal(context, `無効な縦列数 [ ${columns | 0} ] が指定されました`);
        const items = resolveAokanaAddressArray(context.memory, context.thread, addresses, count),
          window = windows.manager.find('window', handle);
        if (window === null) return fatal(context, '無効なウィンドウハンドルが指定されました');
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana selection requires its concrete Window');
        drawAokanaSelectionText(window, items, columns, centered, color);
        window.setTextTransparency(0);
        window.setTextEnabled(1);
        window.composeAll();
        window.disableOverlays();
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xa7,
      nativeAddress: 0x1400d81c0,
      name: 'SetSelectionItemColors',
      execute: (context) => {
        const colors = context.memory.resolve(context.thread, pop32(context.thread)),
          handle = pop32(context.thread),
          window = windows.manager.find('window', handle);
        if (window === null) return fatal(context, '無効なウィンドウハンドルが指定されました');
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana selection requires its concrete Window');
        if (colors === null) window.setTextParameters(null);
        else {
          const view = pointerView(colors, 64);
          window.setTextParameters(
            Uint32Array.from({length: 16}, (_, index) => view.getUint32(index * 4, true)),
          );
        }
        return 0;
      },
    },
  ];
}
