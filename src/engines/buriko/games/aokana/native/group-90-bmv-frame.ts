import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32, push32} from '../bp/state.js';
import {AokanaBmvDecodeProcess} from './bmv-decode-process.js';
import type {AokanaBmvService} from './bmv-service.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaVmControlState} from './group-80-threads.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BmvFrame(
  service: AokanaBmvService,
  loading: AokanaResourceLoadingState,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
  control: AokanaVmControlState,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xf6,
      nativeAddress: 0x1400d6330,
      name: 'DecodeBurikoMovieFrame',
      execute: async (context): Promise<0 | 2> => {
        const frame = pop32(context.thread),
          movie = pop32(context.thread),
          surface = pop32(context.thread);
        let status: number;
        if (control.asynchronousResourceLoads !== 0) {
          status = service.preflight(surface, movie, frame);
          if (status === 0) {
            const process = new AokanaBmvDecodeProcess(
                context.thread,
                procedures,
                clock,
                loading,
                service,
                surface,
                movie,
                frame,
              ),
              node =
                context.thread === scheduler.root.state
                  ? scheduler.root
                  : scheduler.findById(context.thread.id);
            if (node === null || node.state !== context.thread)
              throw new Error('Aokana BMV decode thread is not linked to its scheduler');
            node.installProcess(process);
          }
          control.asynchronousResourceLoads = 0;
          if (status === 0) return 2;
        } else status = await service.decodeSynchronously(surface, movie, frame, context.actor);
        push32(
          context.thread,
          status >= 0x80000003 && status <= 0x80000006 ? status - 0x80000000 : status,
        );
        return 0;
      },
    },
  ];
}
