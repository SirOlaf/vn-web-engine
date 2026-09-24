import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaProcedureState} from './procedure.js';
import {AokanaExtendedTextDisplayProcess} from './text-display-extended-process.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** DF3F0/DF200 both select horizontal CProcDspMsgEx (F2870 selector0). */
export function createGroup91TextDisplay(
  windows: AokanaWindowDisplayState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  notifications: AokanaNativeNotifications,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const execute = async (context: AokanaBpOpcodeContext, optionalEffect: boolean): Promise<2> => {
    pop32(context.thread);
    const wrapping = pop32(context.thread),
      reading = pop32(context.thread),
      other = pop32(context.thread),
      high = pop32(context.thread),
      wait = pop32(context.thread),
      immediate = pop32(context.thread),
      disable = optionalEffect ? pop32(context.thread) : 0,
      color = pop32(context.thread),
      source = context.memory.resolve(context.thread, pop32(context.thread)),
      handle = pop32(context.thread);
    const fatal = (message: string): Promise<never> =>
      errors.threadFatal(
        context.thread,
        context.diagnostics,
        windows.textLayout.text.encodeWide(message, 0),
      );
    const window = windows.manager.find('window', handle);
    if (window === null) return fatal('無効なウィンドウハンドルが指定されました');
    if (!(window instanceof AokanaWindowDisplayObject))
      throw new Error('Aokana extended message lacks its concrete window');
    if (window.fontId === 0) return fatal('指定されたウィンドウにはフォントが設定されていません');
    const process = new AokanaExtendedTextDisplayProcess(
      context.thread,
      procedures,
      clock,
      window,
      input,
      notifications,
    );
    await process.initializeExtended(
      source,
      color,
      reading,
      wrapping,
      disable,
      immediate,
      wait,
      high,
      other,
    );
    const node =
      context.thread === scheduler.root.state
        ? scheduler.root
        : scheduler.findById(context.thread.id);
    if (node === null || node.state !== context.thread)
      throw new Error('Aokana extended message thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  return [
    {
      primary: 0x91,
      secondary: 0x90,
      nativeAddress: 0x1400df3f0,
      name: 'DisplayExtendedWindowMessage',
      execute: (context) => execute(context, false),
    },
    {
      primary: 0x91,
      secondary: 0x92,
      nativeAddress: 0x1400df200,
      name: 'DisplayExtendedWindowMessageOptionalEffect',
      execute: (context) => execute(context, true),
    },
  ];
}
