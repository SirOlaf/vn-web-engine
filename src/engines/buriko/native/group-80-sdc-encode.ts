import {pop32} from '../bp/state.js';
import type {BurikoBpScheduler} from '../bp/scheduler.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorkers} from './data-codec-workers.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import {BurikoSdcEncodeProcess} from './sdc-encode-process.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80SdcEncode(
  workers: BurikoDataCodecWorkers,
  loading: BurikoResourceLoadingState,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
): BurikoNativeSlotDefinition[] {
  scheduler.attachDataCodecWorkers(workers);
  return [
    {
      primary: 0x80,
      secondary: 0xc0,
      nativeAddress: 0x1400e72b0,
      name: 'EncodeSdcData',
      execute: (context) => {
        const count = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          destination = context.memory.resolve(context.thread, pop32(context.thread)),
          process = new BurikoSdcEncodeProcess(
            context,
            procedures,
            clock,
            loading,
            workers,
            destination,
            source,
            count,
          );
        if (process.worker === null) {
          const errors = loading.resources.errors;
          return errors.threadFatal(
            context.thread,
            context.diagnostics,
            errors.files.text.encodeWide('エンコーディング用スレッドの作成に失敗しました', 0),
          );
        }
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko encoder thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
