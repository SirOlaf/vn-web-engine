import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';
import {AokanaTextDisplayProcess} from './text-display-process.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** D8CB0→F2A50→F2870 selector-1, with the complete concrete CProcDspMsg owner. */
export function createGroup90TextDisplay(
  windows: AokanaWindowDisplayState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
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
        if (!(object instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana message window lacks its concrete native owner');
        if (object.fontId === 0)
          return fatal('指定されたウィンドウにはフォントが設定されていません');
        const process = new AokanaTextDisplayProcess(
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
          throw new Error('Aokana message thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
