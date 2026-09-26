import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDisplayManager} from './display-manager.js';
import {AokanaDisplayShakeProcess} from './display-shake-process.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90DisplayShake(
  manager: AokanaDisplayManager,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x2c,
      nativeAddress: 0x1400dbee0,
      name: 'ShakeDisplayObject',
      execute: (context): 2 | Promise<never> => {
        const priority = pop32(context.thread),
          capture = pop32(context.thread),
          frameRate = pop32(context.thread),
          decay = pop32(context.thread),
          cycles = pop32(context.thread),
          frequency = pop32(context.thread),
          amplitude = pop32(context.thread),
          mode = pop32(context.thread),
          handle = pop32(context.thread);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            errors.files.text.encodeWide(message, 0),
          );
        // DBEE0 handles only the four high-bit initializer errors; F2D40's -1 is not fatal here.
        if (manager.resolve(handle) === null) return 2;
        const process = new AokanaDisplayShakeProcess(
          context.thread,
          procedures,
          clock,
          manager,
          input,
          handle,
          () => fatal('オブジェクト制御中にハンドルが削除されました'),
        );
        const status = process.initializeShake(
          mode,
          amplitude,
          frequency,
          cycles,
          decay,
          frameRate,
        );
        if (status !== 0) {
          process.dispose();
          if (status === 0x80000001)
            return fatal(`無効な振動パターン [ ${mode | 0} ] が指定されました`);
          if (status === 0x80000002)
            return fatal(`無効な周波数 [ ${frequency | 0} ] が指定されました`);
          if (status === 0x80000003)
            return fatal(`無効な繰り返し回数 [ ${cycles | 0} ] が指定されました`);
          return fatal(
            `無効なフレームレート [ ${frameRate | 0} ] が指定されました` +
              (frameRate === 0 ? '' : '\n\nフレームレートは周波数と等しいか高くなければなりません'),
          );
        }
        process.configureCapture(capture, priority);
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Aokana display shake thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
