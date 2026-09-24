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
import {AokanaVerticalTextDisplayProcess} from './text-display-vertical-process.js';
import {createAokanaHorizontalTextEffect} from './text-layout-pipeline.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/**E3A00→F2870 selector1 respects the actual window writing direction. */
export function createGroup92TextDisplay(
  windows: AokanaWindowDisplayState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  notifications: AokanaNativeNotifications,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x90,
      nativeAddress: 0x1400e3a00,
      name: 'DisplayDirectedWindowMessage',
      execute: async (context): Promise<2> => {
        const other = pop32(context.thread),
          high = pop32(context.thread),
          wait = pop32(context.thread),
          immediate = pop32(context.thread),
          opacity = pop32(context.thread),
          effectColor = pop32(context.thread),
          radiusY = pop32(context.thread),
          radiusX = pop32(context.thread),
          mode = pop32(context.thread),
          wrapping = pop32(context.thread),
          readingColor = pop32(context.thread),
          reading = pop32(context.thread),
          color = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          handle = pop32(context.thread);
        const effect = createAokanaHorizontalTextEffect(
          mode,
          radiusX,
          radiusY,
          effectColor,
          opacity,
        );
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            windows.textLayout.text.encodeWide(message, 0),
          );
        const window = windows.manager.find('window', handle);
        if (window === null) return fatal('無効なウィンドウハンドルが指定されました');
        if (!(window instanceof AokanaWindowDisplayObject))
          throw new Error('Aokana directed message lacks its concrete window');
        if (window.fontId === 0)
          return fatal('指定されたウィンドウにはフォントが設定されていません');
        const Process =
          window.writingDirection === 1
            ? AokanaVerticalTextDisplayProcess
            : AokanaExtendedTextDisplayProcess;
        const process = new Process(
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
          0,
          immediate,
          wait,
          high,
          other,
          readingColor,
          effect,
        );
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Aokana directed message thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
