import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaNativeCursorMotion} from './cursor-motion.js';
import type {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaProcedureState, AokanaWindowMessages} from './procedure.js';
import {AokanaSelectionProcess} from './selection-process.js';
import type {AokanaSelectionState} from './selection-state.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import {resolveAokanaAddressArray} from './vm-address-array.js';

/** D86C0→F3340 installs the complete base selection procedure; setters share its globals. */
export function createGroup90SelectionProcess(
  windows: AokanaWindowDisplayState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  waits: AokanaWindowMessages,
  notifications: AokanaNativeNotifications,
  cursor: AokanaNativeCursorMotion,
  settings: AokanaSelectionState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xa0,
      nativeAddress: 0x1400d86c0,
      name: 'SelectTextItem',
      execute: (context) => {
        const cancel = pop32(context.thread),
          selection = pop32(context.thread),
          color = pop32(context.thread),
          centered = pop32(context.thread),
          columns = pop32(context.thread),
          addresses = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          handle = pop32(context.thread);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            windows.textLayout.text.encodeWide(message, 0),
          );
        if ((count - 1) >>> 0 > 15) return fatal(`無効な項目数 [ ${count | 0} ] が指定されました`);
        if ((selection | 0) < 0 || count >>> 0 <= selection >>> 0)
          return fatal(`無効な初期選択項目番号 [ ${selection | 0} ] が指定されました`);
        if (columns >>> 0 >= 17) return fatal(`無効な縦列数 [ ${columns | 0} ] が指定されました`);
        const items = resolveAokanaAddressArray(context.memory, context.thread, addresses, count),
          window = windows.manager.find('window', handle);
        if (window === null) return fatal('無効なウィンドウハンドルが指定されました');
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana selection lacks its concrete Window');
        if (window.fontId === 0)
          return fatal('指定されたウィンドウにはフォントが設定されていません');
        const process = new AokanaSelectionProcess(
          context.thread,
          procedures,
          clock,
          window,
          input,
          waits,
          notifications,
          cursor,
          settings,
        );
        process.initialize(items, columns, centered, color, selection, cancel);
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Aokana selection thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
    {
      primary: 0x90,
      secondary: 0xa4,
      nativeAddress: 0x1400d8280,
      name: 'SetSelectionBlinkColors',
      execute: (context) => {
        const second = pop32(context.thread),
          first = pop32(context.thread);
        settings.colors[0] = first;
        settings.colors[1] = second;
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xa5,
      nativeAddress: 0x1400d8260,
      name: 'SetSelectionBlinkInterval',
      execute: (context) => {
        settings.interval = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xa6,
      nativeAddress: 0x1400d8210,
      name: 'SetSelectionWheelMotion',
      execute: (context) => {
        const rate = pop32(context.thread),
          duration = pop32(context.thread),
          easing = pop32(context.thread),
          wheel = pop32(context.thread);
        settings.wheelMotion = wheel;
        settings.cursorEasing = easing;
        settings.cursorDuration = duration;
        settings.cursorRate = rate;
        return 0;
      },
    },
  ];
}
