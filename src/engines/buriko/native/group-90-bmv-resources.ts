import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32, push32} from '../bp/state.js';
import {BurikoBmvLoadProcess} from './bmv-load-process.js';
import type {BurikoBmvRegistry} from './bmv-registry.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** 90:F4/F5/F7 share the encoded BMV owner; frame-decoding service F6 is separate. */
export function createGroup90BmvResources(
  registry: BurikoBmvRegistry,
  loading: BurikoResourceLoadingState,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
): BurikoNativeSlotDefinition[] {
  const address = (context: BurikoBpOpcodeContext) =>
    context.memory.resolve(context.thread, pop32(context.thread));
  return [
    {
      primary: 0x90,
      secondary: 0xf4,
      nativeAddress: 0x1400d6450,
      name: 'LoadBurikoMovieResource',
      execute: async (context): Promise<2> => {
        const name = address(context),
          archive = address(context),
          metadata = address(context),
          output = address(context);
        const process = await BurikoBmvLoadProcess.create(
            context,
            procedures,
            clock,
            loading,
            registry,
            output,
            metadata,
            archive,
            name,
          ),
          node =
            context.thread === scheduler.root.state
              ? scheduler.root
              : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko BMV resource thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
    {
      primary: 0x90,
      secondary: 0xf5,
      nativeAddress: 0x1400d63f0,
      name: 'ReleaseBurikoMovieResource',
      execute: (context) => {
        const status = registry.remove(pop32(context.thread));
        push32(context.thread, status === 0x80000003 ? 3 : status);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xf7,
      nativeAddress: 0x1400d62c0,
      name: 'AliasBurikoMovieResource',
      execute: (context) => {
        const handle = pop32(context.thread),
          output = address(context),
          status = registry.alias(output, handle);
        push32(context.thread, status === 0x80000003 ? 3 : status === 0x80000007 ? 7 : status);
        return 0;
      },
    },
  ];
}
