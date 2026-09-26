import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import {BurikoCoordinateSplineControlProcess} from './display-coordinate-spline-process.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Runtime 90:29 installs the coordinate CSpline process through the real scheduler. */
export function createGroup90CoordinateSplineControl(
  manager: BurikoDisplayManager,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  input: BurikoNativeInput,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  return [
    {
      primary: 0x90,
      secondary: 0x29,
      nativeAddress: 0x1400dc070,
      name: 'ControlDisplayCoordinateSpline',
      execute: (context) => {
        const priority = pop32(context.thread),
          capture = pop32(context.thread),
          limit = pop32(context.thread),
          frequency = pop32(context.thread),
          duration = pop32(context.thread),
          depth = pop32(context.thread),
          packedBlend = pop32(context.thread),
          blend = pop32(context.thread),
          positionEasing = pop32(context.thread),
          points = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          handle = pop32(context.thread);
        if (priority >= 0x10000)
          return fatal(context, `無効なプライオリティ [ ${priority | 0} ] が指定されました`);
        if ((depth + 1) >>> 0 >= 0x102)
          return fatal(context, `無効なアディションレベル [ ${depth | 0} ] が指定されました`);
        if (blend > 0x100)
          return fatal(
            context,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
          );
        if (frequency === 0)
          return fatal(context, `無効なフレームレート [ ${frequency | 0} ] が指定されました`);
        if (manager.resolve(handle) === null)
          return fatal(context, '無効なオブジェクトハンドルが指定されました');
        const process = new BurikoCoordinateSplineControlProcess(
          context.thread,
          procedures,
          clock,
          manager,
          input,
          handle,
          () => fatal(context, 'オブジェクト制御中にハンドルが削除されました'),
        );
        const status = process.initializeCoordinates(
          count,
          points,
          positionEasing,
          blend,
          packedBlend,
          depth,
          duration,
          frequency,
          limit,
        );
        if (status === 0x80000001) {
          process.dispose();
          return fatal(context, `無効な座標数 [ ${count | 0} ] が指定されました`);
        }
        process.configureCapture(capture, priority);
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko coordinate control thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
