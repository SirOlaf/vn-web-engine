import {pop32} from '../bp/state.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDataCodecWorkers} from './data-codec-workers.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import {AokanaDataDecodeProcess} from './data-decode-process.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup80DataDecode(
  workers: AokanaDataCodecWorkers,
  loading: AokanaResourceLoadingState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
  scheduler.attachDataCodecWorkers(workers);
  return [
    {
      primary: 0x80,
      secondary: 0xcf,
      nativeAddress: 0x1400e7090,
      name: 'DecodeData',
      execute: (context) => {
        const count = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          destination = context.memory.resolve(context.thread, pop32(context.thread)),
          process = new AokanaDataDecodeProcess(
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
            errors.files.text.encodeWide('デコーディング用スレッドの作成に失敗しました', 0),
          );
        }
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Aokana data decoder thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
