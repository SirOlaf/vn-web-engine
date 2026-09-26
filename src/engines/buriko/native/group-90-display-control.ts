import {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import {
  BurikoDisplayControlProcess,
  BurikoSplineDisplayControlProcess,
} from './display-control-process.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoProcedureState} from './procedure.js';
import type {
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
  BurikoNativeSlotDefinition,
} from './types.js';

/** Runtime 90:20-24,28: real CProcCtrlDspObj/CProcCtrlDspObjSp wait processes. */
export function createGroup90DisplayControl(
  manager: BurikoDisplayManager,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  input: BurikoNativeInput,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const slots: BurikoNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: BurikoBpOpcodeHandler,
  ): void => {
    slots.push({primary: 0x90, secondary, nativeAddress, name, execute});
  };
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  const install = (context: BurikoBpOpcodeContext, process: BurikoDisplayControlProcess): 2 => {
    const node =
      context.thread === scheduler.root.state
        ? scheduler.root
        : scheduler.findById(context.thread.id);
    if (node === null || node.state !== context.thread)
      throw new Error('Buriko display control thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  const initialize = (
    context: BurikoBpOpcodeContext,
    handle: number,
    target: readonly [number, number, number] | null,
    blend: number,
    duration: number,
    frequency: number,
    limit: number,
    capture: number,
    priority: number,
    full?: {depth: number; blendEasing: number},
  ): 2 | Promise<never> => {
    // All VM operands have already been popped before any validation or allocation.
    if (priority >= 0x10000)
      return fatal(context, `無効なプライオリティ [ ${priority | 0} ] が指定されました`);
    if (full !== undefined && (full.depth + 1) >>> 0 >= 0x102)
      return fatal(context, `無効なアディションレベル [ ${full.depth | 0} ] が指定されました`);
    if (blend > 0x100)
      return fatal(
        context,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
      );
    if (frequency === 0)
      return fatal(context, `無効なフレームレート [ ${frequency | 0} ] が指定されました`);
    if (manager.resolve(handle) === null)
      return fatal(context, '無効なオブジェクトハンドルが指定されました');
    const process = new BurikoDisplayControlProcess(
      context.thread,
      procedures,
      clock,
      manager,
      input,
      handle,
      () => fatal(context, 'オブジェクト制御中にハンドルが削除されました'),
    );
    if (full === undefined) process.initialize(target, blend, duration, frequency, limit);
    else
      process.initializeFull(
        target![0],
        target![1],
        target![2],
        blend,
        full.blendEasing,
        full.depth,
        duration,
        frequency,
        limit,
      );
    process.configureCapture(capture, priority);
    return install(context, process);
  };

  add(0x20, 0x1400dc970, 'ControlDisplayBlend', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      blend = pop32(context.thread),
      handle = pop32(context.thread);
    return initialize(context, handle, null, blend, duration, frequency, 0, capture, priority);
  });
  add(0x21, 0x1400dc700, 'ControlDisplayPosition', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      blend = pop32(context.thread),
      easing = pop32(context.thread),
      y = pop32(context.thread),
      x = pop32(context.thread),
      handle = pop32(context.thread);
    return initialize(
      context,
      handle,
      [x, y, easing],
      blend,
      duration,
      frequency,
      0,
      capture,
      priority,
    );
  });
  add(0x22, 0x1400dc850, 'ControlDisplayBlendLimited', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      limit = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      blend = pop32(context.thread),
      handle = pop32(context.thread);
    return initialize(context, handle, null, blend, duration, frequency, limit, capture, priority);
  });
  add(0x23, 0x1400dc5a0, 'ControlDisplayPositionLimited', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      limit = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      blend = pop32(context.thread),
      easing = pop32(context.thread),
      y = pop32(context.thread),
      x = pop32(context.thread),
      handle = pop32(context.thread);
    return initialize(
      context,
      handle,
      [x, y, easing],
      blend,
      duration,
      frequency,
      limit,
      capture,
      priority,
    );
  });
  add(0x24, 0x1400dc3e0, 'ControlDisplaySpline', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      limit = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      blend = pop32(context.thread),
      easing = pop32(context.thread),
      endY = pop32(context.thread),
      endX = pop32(context.thread),
      viaY = pop32(context.thread),
      viaX = pop32(context.thread),
      handle = pop32(context.thread);
    if (priority >= 0x10000)
      return fatal(context, `無効なプライオリティ [ ${priority | 0} ] が指定されました`);
    if (blend > 0x100)
      return fatal(
        context,
        `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
      );
    // Unlike 20-23, 24 resolves the object before constructing and checking frequency.
    if (manager.resolve(handle) === null)
      return fatal(context, '無効なオブジェクトハンドルが指定されました');
    const process = new BurikoSplineDisplayControlProcess(
        context.thread,
        procedures,
        clock,
        manager,
        input,
        handle,
        () => fatal(context, 'オブジェクト制御中にハンドルが削除されました'),
      ),
      status = process.initializeSpline(
        viaX,
        viaY,
        endX,
        endY,
        easing,
        blend,
        duration,
        frequency,
        limit,
      );
    if (status !== 0) {
      process.dispose();
      if (status === 0x80000001)
        return fatal(context, `無効なフレームレート [ ${frequency | 0} ] が指定されました`);
      return fatal(
        context,
        `指定された経由Ｘ座標 [ ${viaX | 0} ] / 目標Ｘ座標 [ ${endX | 0} ] ではＸ方向のベクトルの一貫性がとれません`,
      );
    }
    process.configureCapture(capture, priority);
    return install(context, process);
  });
  add(0x28, 0x1400dc240, 'ControlDisplayFull', (context) => {
    const priority = pop32(context.thread),
      capture = pop32(context.thread),
      limit = pop32(context.thread),
      frequency = pop32(context.thread),
      duration = pop32(context.thread),
      depth = pop32(context.thread),
      blendEasing = pop32(context.thread),
      blend = pop32(context.thread),
      positionEasing = pop32(context.thread),
      y = pop32(context.thread),
      x = pop32(context.thread),
      handle = pop32(context.thread);
    return initialize(
      context,
      handle,
      [x, y, positionEasing],
      blend,
      duration,
      frequency,
      limit,
      capture,
      priority,
      {depth, blendEasing},
    );
  });
  return slots;
}
