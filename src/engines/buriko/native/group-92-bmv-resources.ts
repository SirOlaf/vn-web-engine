import type {BurikoBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import {BurikoBmvHeaderLoadProcess} from './bmv-header-load-process.js';
import {BurikoBmvLoadProcess} from './bmv-load-process.js';
import type {BurikoBmvRegistry} from './bmv-registry.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 92:F1 (0E2F60) chooses the full-resource or partial-header process after all pointer pops. */
export function createGroup92BmvResources(
  registry: BurikoBmvRegistry,
  loading: BurikoResourceLoadingState,
  scheduler: BurikoBpScheduler,
  procedures: BurikoProcedureState,
  clock: BurikoNativeClock,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0xf1,
      nativeAddress: 0x1400e2f60,
      name: 'LoadBurikoMovieResourceOrHeader',
      execute: async (context): Promise<2> => {
        const address = () => context.memory.resolve(context.thread, pop32(context.thread));
        const mode = pop32(context.thread),
          name = address(),
          archive = address(),
          metadata = address(),
          output = address();
        const process =
          mode === 0
            ? await BurikoBmvLoadProcess.create(
                context,
                procedures,
                clock,
                loading,
                registry,
                output,
                metadata,
                archive,
                name,
              )
            : new BurikoBmvHeaderLoadProcess(
                context,
                procedures,
                clock,
                loading,
                registry,
                output,
                metadata,
                archive,
                name,
              );
        const node =
          context.thread === scheduler.root.state
            ? scheduler.root
            : scheduler.findById(context.thread.id);
        if (node === null || node.state !== context.thread)
          throw new Error('Buriko BMV partial resource thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
