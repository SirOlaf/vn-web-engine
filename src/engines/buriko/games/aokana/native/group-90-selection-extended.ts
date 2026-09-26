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
import {
  AokanaSelectionExtendedProcess,
  AokanaSelectionBlinkProcess,
} from './selection-extended-process.js';
import type {AokanaSelectionState} from './selection-state.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
import {resolveAokanaAddressArray} from './vm-address-array.js';

/** D82C0/D82B0→D82D0→F2B60 install the actual Ex and ExBlink procedures. */
export function createGroup90SelectionExtended(
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
  const execute = (context: AokanaBpOpcodeContext, extended: boolean): 2 | Promise<never> => {
    const secondY = pop32(context.thread),
      secondX = pop32(context.thread),
      second = pop32(context.thread),
      firstY = pop32(context.thread),
      firstX = pop32(context.thread),
      first = pop32(context.thread),
      cancel = pop32(context.thread),
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
      throw new Error('Aokana extended selection lacks its concrete Window');
    if (window.fontId === 0) return fatal('指定されたウィンドウにはフォントが設定されていません');
    const Process = extended ? AokanaSelectionExtendedProcess : AokanaSelectionBlinkProcess;
    const process = new Process(
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
    const status = process.configureOverlays(first, firstX, firstY, second, secondX, secondY);
    if (status !== 0) {
      process.dispose();
      const bitmap = status === 0x8001 || status === 0x8002 ? first : second;
      return fatal(
        status === 0x8001 || status === 0x8003
          ? `指定されたビットマップ [ ${bitmap | 0} ] は無効です`
          : `指定されたビットマップ [ ${bitmap | 0} ] はスクリーンと互換性がありません`,
      );
    }
    const node =
      context.thread === scheduler.root.state
        ? scheduler.root
        : scheduler.findById(context.thread.id);
    if (node === null || node.state !== context.thread)
      throw new Error('Aokana extended selection thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xa2,
      nativeAddress: 0x1400d82c0,
      name: 'SelectTextItemWithMarkers',
      execute: (context) => execute(context, true),
    },
    {
      primary: 0x90,
      secondary: 0xa3,
      nativeAddress: 0x1400d82b0,
      name: 'BlinkSelectedTextItem',
      execute: (context) => execute(context, false),
    },
  ];
}
