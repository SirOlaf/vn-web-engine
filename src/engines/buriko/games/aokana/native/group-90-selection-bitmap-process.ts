import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDisplayManager} from './display-manager.js';
import {AokanaWindowDisplayObject} from './display-window.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaIndependentIconState} from './independent-icon.js';
import type {AokanaNativeInput} from './input.js';
import type {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaProcedureState, AokanaWindowMessages} from './procedure.js';
import {
  AokanaBitmapSelectionProcess,
  AokanaExtendedBitmapSelectionProcess,
} from './selection-bitmap-process.js';
import type {AokanaBitmapSelectionState} from './selection-bitmap-state.js';
import type {AokanaSelectionState} from './selection-state.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup90SelectionBitmapProcess(
  manager: AokanaDisplayManager,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  input: AokanaNativeInput,
  waits: AokanaWindowMessages,
  notifications: AokanaNativeNotifications,
  settings: AokanaBitmapSelectionState,
  textSettings: AokanaSelectionState,
  iconSettings: AokanaIndependentIconState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const execute = (h: AokanaBpOpcodeContext, extended: boolean): 2 | Promise<never> => {
    const hitMask = pop32(h.thread),
      cancel = pop32(h.thread),
      mode = pop32(h.thread),
      keys = h.memory.resolve(h.thread, pop32(h.thread)),
      records = h.memory.resolve(h.thread, pop32(h.thread)),
      count = pop32(h.thread),
      handle = pop32(h.thread);
    const fatal = (message: string) =>
      errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
    if ((count - 1) >>> 0 >= 64) return fatal(`無効なアイコン数 [ ${count | 0} ] が指定されました`);
    if (mode >>> 0 >= 4) return fatal(`無効なフォーカスモード [ ${mode | 0} ] が指定されました`);
    const window = manager.find('window', handle);
    if (window === null) return fatal('無効なウィンドウハンドルが指定されました');
    if (!(window instanceof AokanaWindowDisplayObject))
      throw new Error('Aokana bitmap selection requires actual Window owner');
    const Process = extended ? AokanaExtendedBitmapSelectionProcess : AokanaBitmapSelectionProcess;
    const process = new Process(
      h.thread,
      procedures,
      clock,
      window,
      input,
      waits,
      notifications,
      settings,
      mode,
    );
    process.setCancelEnabled(cancel);
    if (process.initialize(count, records, hitMask) !== 0)
      return fatal('指定されたビットマップの中に無効なものが含まれています');
    if (keys !== null) process.configureKeys(keys);
    const node =
      h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
    if (node === null || node.state !== h.thread)
      throw new Error('Aokana bitmap selection thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  return [
    {
      primary: 0x90,
      secondary: 0xaf,
      nativeAddress: 0x1400d81a0,
      name: 'SetSelectionForegroundOnly',
      execute: (h) => {
        const value = pop32(h.thread);
        settings.foregroundOnly = value;
        textSettings.foregroundOnly = value;
        iconSettings.foregroundOnly = value;
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xb0,
      nativeAddress: 0x1400d8070,
      name: 'SelectBitmapIcon',
      execute: (h) => execute(h, false),
    },
    {
      primary: 0x90,
      secondary: 0xb1,
      nativeAddress: 0x1400d7f40,
      name: 'SelectExtendedBitmapIcon',
      execute: (h) => execute(h, true),
    },
  ];
}
