import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDisplayManager} from './display-manager.js';
import {BurikoWindowDisplayObject} from './display-window.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoIndependentIconState} from './independent-icon.js';
import type {BurikoNativeInput} from './input.js';
import type {BurikoNativeNotifications} from './notification-queue.js';
import type {BurikoProcedureState, BurikoWindowMessages} from './procedure.js';
import {
  BurikoBitmapSelectionProcess,
  BurikoExtendedBitmapSelectionProcess,
} from './selection-bitmap-process.js';
import type {BurikoBitmapSelectionState} from './selection-bitmap-state.js';
import type {BurikoSelectionState} from './selection-state.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** The standalone 90:AF definition shares the three states used by selection processes and B4590. */
export function createGroup90SelectionForegroundOnly(
  settings: BurikoBitmapSelectionState,
  textSettings: BurikoSelectionState,
  iconSettings: BurikoIndependentIconState,
): BurikoNativeSlotDefinition[] {
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
  ];
}

export function createGroup90SelectionBitmapProcess(
  manager: BurikoDisplayManager,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  input: BurikoNativeInput,
  waits: BurikoWindowMessages,
  notifications: BurikoNativeNotifications,
  settings: BurikoBitmapSelectionState,
  textSettings: BurikoSelectionState,
  iconSettings: BurikoIndependentIconState,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const execute = (h: BurikoBpOpcodeContext, extended: boolean): 2 | Promise<never> => {
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
    if (!(window instanceof BurikoWindowDisplayObject))
      throw new Error('Buriko bitmap selection requires actual Window owner');
    const Process = extended ? BurikoExtendedBitmapSelectionProcess : BurikoBitmapSelectionProcess;
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
      throw new Error('Buriko bitmap selection thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  return [
    ...createGroup90SelectionForegroundOnly(settings, textSettings, iconSettings),
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
