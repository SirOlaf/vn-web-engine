import {pop32} from '../bp/state.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaLoadSoundProcess} from './load-sound-process.js';
import type {AokanaProcedureState} from './procedure.js';
import {AokanaRegisterSoundProcess} from './register-sound-process.js';
import type {AokanaSharedLoaderWorker} from './shared-loader-worker.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

const sound = [150, 179, 140, 248, 130, 200, 140, 248, 137, 202, 137, 185, 148, 212, 141, 134];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

/** E56B0/E55D0/E54C0/E52A0/E51B0 install real resource/static wait processes. */
export function createGroupA0SoundProcesses(
  worker: AokanaSharedLoaderWorker,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
  scheduler.attachSharedLoaderWorker(worker);
  const install = (
    context: AokanaBpOpcodeContext,
    process: AokanaLoadSoundProcess | AokanaRegisterSoundProcess,
  ): 2 => {
    const node =
      context.thread === scheduler.root.state
        ? scheduler.root
        : scheduler.findById(context.thread.id);
    if (node === null || node.state !== context.thread)
      throw new Error('Aokana sound process thread is not linked to its scheduler');
    node.installProcess(process);
    return 2;
  };
  const validateChannel = (
    context: AokanaBpOpcodeContext,
    channel: number,
  ): Promise<never> | null =>
    channel >>> 0 >= 128
      ? worker.loading.resources.errors.threadFatal(
          context.thread,
          context.diagnostics,
          Uint8Array.from([
            ...sound,
            ...new TextEncoder().encode(` [ ${channel | 0} ] `),
            ...suffix,
          ]),
        )
      : null;
  const resourceSlot = (
    secondary: number,
    nativeAddress: number,
    name: string,
    kind: 'zero' | 'normal' | 'double' | 'variable',
  ): AokanaNativeSlotDefinition => ({
    primary: 0xa0,
    secondary,
    nativeAddress,
    name,
    execute: async (context): Promise<2> => {
      const speed =
        kind === 'variable'
          ? (pop32(context.thread) | 0) / 65536
          : kind === 'zero'
            ? 0
            : kind === 'double'
              ? 2
              : 1;
      const gain = kind === 'zero' ? 0 : (pop32(context.thread) | 0) / 65536;
      const fade = kind === 'zero' ? 0 : pop32(context.thread);
      const memberAddress = pop32(context.thread);
      const archiveAddress = pop32(context.thread);
      const channel = pop32(context.thread);
      const failure = validateChannel(context, channel);
      if (failure !== null) return failure;
      const member = context.memory.resolve(context.thread, memberAddress);
      const archive = context.memory.resolve(context.thread, archiveAddress);
      const process = await AokanaLoadSoundProcess.create(
        context,
        procedures,
        clock,
        worker.loading,
        worker.audio,
        channel,
        fade,
        gain,
        speed,
        archive,
        member,
      );
      return install(context, process);
    },
  });
  return [
    resourceSlot(0x20, 0x1400e56b0, 'LoadStaticSoundZeroSpeed', 'zero'),
    resourceSlot(0x21, 0x1400e55d0, 'LoadStaticSound', 'normal'),
    resourceSlot(0x23, 0x1400e54c0, 'LoadStaticSoundDoubleSpeed', 'double'),
    resourceSlot(0x27, 0x1400e52a0, 'LoadStaticSoundVariableSpeed', 'variable'),
    {
      primary: 0xa0,
      secondary: 0x28,
      nativeAddress: 0x1400e51b0,
      name: 'RegisterStaticSound',
      execute: (context) => {
        const speed = (pop32(context.thread) | 0) / 65536;
        const gain = (pop32(context.thread) | 0) / 65536;
        const fade = pop32(context.thread);
        const sourceAddress = pop32(context.thread);
        const channel = pop32(context.thread);
        const failure = validateChannel(context, channel);
        if (failure !== null) return failure;
        const source = context.memory.resolve(context.thread, sourceAddress);
        return install(
          context,
          new AokanaRegisterSoundProcess(
            context,
            procedures,
            clock,
            worker.loading,
            worker.audio,
            channel,
            source,
            fade,
            gain,
            speed,
          ),
        );
      },
    },
  ];
}
