import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoWindowDisplayState} from './display-window-state.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoProcedureState} from './procedure.js';
import {BurikoTextDisplayProcess} from './text-display-process.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** D8CB0→F2A50→F2870 selector-1, with the complete concrete CProcDspMsg owner. */
export function createGroup90TextDisplay(
  windows: BurikoWindowDisplayState,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  input: BurikoNativeInput,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x90,
      nativeAddress: 0x1400d8cb0,
      name: 'DisplayWindowMessage',
      execute: (context) => {
        const highBit = pop32(context.thread),
          wait = pop32(context.thread),
          immediate = pop32(context.thread),
          color = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          handle = pop32(context.thread);
        const object = windows.manager.find('window', handle);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            windows.textLayout.text.encodeWide(message, 0),
          );
        if (object === null) return fatal('無効なウィンドウハンドルが指定されました');
        if (!(object instanceof BurikoWindowDisplayObject))
          throw new Error('Buriko message window lacks its concrete native owner');
        if (object.fontId === 0)
          return fatal('指定されたウィンドウにはフォントが設定されていません');
        const process = new BurikoTextDisplayProcess(
          context.thread,
          procedures,
          clock,
          object,
          input,
        );
        process.initialize(source, color, immediate, wait, highBit, 1);
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko message thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
