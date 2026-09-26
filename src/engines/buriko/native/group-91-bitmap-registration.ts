import {pop32, push32} from '../bp/state.js';
import type {BurikoBpScheduler} from '../bp/scheduler.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorkers} from './data-codec-workers.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoBitmapRegistration} from './bitmap-registration.js';
import {BurikoRegisterBitmapProcess} from './register-bitmap-process.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup91BitmapRegistration(
  registration: BurikoBitmapRegistration,
  workers: BurikoDataCodecWorkers,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
): BurikoNativeSlotDefinition[] {
  scheduler.attachDataCodecWorkers(workers);
  return [
    {
      primary: 0x91,
      secondary: 0x03,
      nativeAddress: 0x1400e2c00,
      name: 'RegisterResourceData',
      execute: (context) => {
        const count = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          name = context.memory.resolve(context.thread, pop32(context.thread)),
          archive = context.memory.resolve(context.thread, pop32(context.thread));
        push32(context.thread, registration.cache(archive, name, source, count));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x04,
      nativeAddress: 0x1400e2b30,
      name: 'DecodeAndRegisterBitmap',
      execute: (context) => {
        const flag = pop32(context.thread),
          name = context.memory.resolve(context.thread, pop32(context.thread)),
          archive = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          index = pop32(context.thread),
          process = new BurikoRegisterBitmapProcess(
            context,
            procedures,
            clock,
            workers,
            registration,
            index,
            source,
            count,
            archive,
            name,
            flag,
          );
        if (process.worker === null) {
          const errors = registration.loading.resources.errors;
          return errors.threadFatal(
            context.thread,
            context.diagnostics,
            errors.files.text.encodeWide('デコーディング用スレッドの作成に失敗しました', 0),
          );
        }
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko bitmap registration thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
