import {pop32, push32} from '../bp/state.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDataCodecWorkers} from './data-codec-workers.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaStructCodecScratch} from './struct-codec-scratch.js';
import {AokanaStructEncodeProcess} from './struct-encode-process.js';
import {codecView, type AokanaCodecPointer} from './codec-storage.js';
import {decodeAokanaDcfs} from './dcfs.js';
import {decodeAokanaSdcInto} from './sdc.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup80StructCodec(
  workers: AokanaDataCodecWorkers,
  loading: AokanaResourceLoadingState,
  scratch: AokanaStructCodecScratch,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
  scheduler.attachDataCodecWorkers(workers);
  return [
    {
      primary: 0x80,
      secondary: 0xc4,
      nativeAddress: 0x1400e71c0,
      name: 'EncodeStructData',
      execute: (context) => {
        const count = pop32(context.thread),
          size = pop32(context.thread),
          source = context.memory.resolve(context.thread, pop32(context.thread)),
          destination = context.memory.resolve(context.thread, pop32(context.thread)),
          process = new AokanaStructEncodeProcess(
            context,
            procedures,
            clock,
            loading,
            workers,
            scratch,
            destination,
            source,
            size,
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
          throw new Error('Aokana struct encoder thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
    {
      primary: 0x80,
      secondary: 0xc5,
      nativeAddress: 0x1400e7120,
      name: 'DecodeStructData',
      execute: (context) => {
        const source = context.memory.resolve(context.thread, pop32(context.thread)),
          destination = context.memory.resolve(context.thread, pop32(context.thread)),
          magic = 'SDC FORMAT 1.00\0';
        for (let index = 0; index < magic.length; index++) {
          if (codecView(source, index, 1).getUint8(0) !== magic.charCodeAt(index)) {
            push32(context.thread, 0);
            return 0;
          }
        }
        const extent = codecView(source, 24, 4).getUint32(0, true),
          storage: AokanaCodecPointer = {
            bytes: new Uint8Array(extent),
            offset: 0,
            initialized: new Uint8Array(extent),
          };
        decodeAokanaSdcInto(storage, source);
        const status = decodeAokanaDcfs(destination, storage);
        push32(context.thread, status === 0 ? codecView(storage, 20, 4).getUint32(0, true) : 0);
        return 0;
      },
    },
  ];
}
