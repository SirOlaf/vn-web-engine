import {pop32} from '../bp/state.js';
import type {BurikoBpScheduler} from '../bp/scheduler.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoVmControlState} from './group-80-threads.js';
import type {BurikoProcedureState} from './procedure.js';
import {formatBurikoAudioNames} from './audio/resource-music.js';
import {
  BurikoSetMusicProcess,
  burikoSetMusicMissingDiagnostic,
  burikoSetMusicInvalidWaveDiagnostic,
  burikoSetMusicGenericFailureDiagnostic,
} from './set-music-process.js';
import type {BurikoSharedLoaderWorker} from './shared-loader-worker.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

const pan = [
  150, 179, 140, 248, 130, 200, 131, 112, 131, 147, 131, 124, 131, 98, 131, 103, 129, 105, 146, 232,
  136, 202, 129, 106,
];
const volume = [
  150, 179, 140, 248, 130, 200, 131, 123, 131, 138, 131, 133, 129, 91, 131, 128, 129, 105, 137, 185,
  151, 202, 129, 106,
];
const musicChannel = [
  150, 179, 140, 248, 130, 200, 137, 185, 138, 121, 131, 96, 131, 131, 131, 147, 131, 108, 131, 139,
  148, 212, 141, 134,
];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];
const nullName = new TextEncoder().encode('(null)\0');

/** E5B80 selects the real synchronous music lower or DCProcSetMusic on the shared loader. */
export function createGroupA0MusicLoad(
  worker: BurikoSharedLoaderWorker,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
  control: BurikoVmControlState,
): BurikoNativeSlotDefinition[] {
  if (worker.audio.music.resources !== worker.loading.resources)
    throw new Error('Buriko music load must share the worker resource owner');
  scheduler.attachSharedLoaderWorker(worker);
  const fatal = (context: BurikoBpOpcodeContext, prefix: number[], value: number) =>
    worker.loading.resources.errors.threadFatal(
      context.thread,
      context.diagnostics,
      Uint8Array.from([...prefix, ...new TextEncoder().encode(` [ ${value | 0} ] `), ...suffix]),
    );
  return [
    {
      primary: 0xa0,
      secondary: 0x11,
      nativeAddress: 0x1400e5b80,
      name: 'LoadMusicResource',
      execute: async (context): Promise<0 | 2> => {
        const position = pop32(context.thread),
          level = pop32(context.thread),
          nameAddress = pop32(context.thread),
          archiveAddress = pop32(context.thread),
          channel = pop32(context.thread);
        if (position >>> 0 > 128) return fatal(context, pan, position);
        if (level >>> 0 > 128) return fatal(context, volume, level);
        if (channel >>> 0 >= 16) return fatal(context, musicChannel, channel);
        const resolve = (address: number) => context.memory.resolve(context.thread, address),
          name = () => {
            const pointer = resolve(nameAddress);
            if (pointer === null) throw new Error('Buriko music name dereferences a null pointer');
            return textBytes(pointer, true);
          },
          archive =
            archiveAddress === 0
              ? null
              : () => {
                  const pointer = resolve(archiveAddress);
                  if (pointer === null)
                    throw new Error('Buriko music archive dereferences a null pointer');
                  return textBytes(pointer, true);
                };
        if (control.asynchronousResourceLoads !== 0) {
          const node =
            context.thread === scheduler.root.state
              ? scheduler.root
              : scheduler.findById(context.thread.id);
          if (node === null || node.state !== context.thread)
            throw new Error('Buriko music thread is not linked to its scheduler');
          const process = new BurikoSetMusicProcess(
            context,
            procedures,
            clock,
            worker.loading,
            worker.audio,
            channel,
            resolve(archiveAddress),
            resolve(nameAddress),
            level,
            position,
          );
          node.installProcess(process);
          control.asynchronousResourceLoads = 0;
          return 2;
        }
        const status = await worker.audio.music.loadMusic(
          channel,
          archive,
          name,
          level,
          position,
          context.actor ?? worker.audio.metadata.allocator.currentActor,
        );
        if (status === 0) return 0;
        const diagnostic =
          status === 12 || status === 14
            ? formatBurikoAudioNames(
                status === 12
                  ? burikoSetMusicMissingDiagnostic
                  : burikoSetMusicInvalidWaveDiagnostic,
                [archive === null ? nullName : archive(), name()],
                256,
              )
            : burikoSetMusicGenericFailureDiagnostic;
        return worker.loading.resources.errors.threadFatal(
          context.thread,
          context.diagnostics,
          diagnostic,
        );
      },
    },
  ];
}
