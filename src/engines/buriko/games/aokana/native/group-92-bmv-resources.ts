import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32} from '../bp/state.js';
import {AokanaBmvHeaderLoadProcess} from './bmv-header-load-process.js';
import {AokanaBmvLoadProcess} from './bmv-load-process.js';
import type {AokanaBmvRegistry} from './bmv-registry.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** 92:F1 (0E2F60) chooses the full-resource or partial-header process after all pointer pops. */
export function createGroup92BmvResources(
  registry: AokanaBmvRegistry,
  loading: AokanaResourceLoadingState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
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
            ? await AokanaBmvLoadProcess.create(
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
            : new AokanaBmvHeaderLoadProcess(
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
          throw new Error('Aokana BMV partial resource thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
  ];
}
