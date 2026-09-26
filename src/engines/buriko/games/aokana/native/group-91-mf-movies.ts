import type {AokanaBpScheduler} from '../bp/scheduler.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import {AokanaBrowserMfMovieSession} from './movie-mf-browser-session.js';
import {AokanaMfMovieProcess} from './movie-mf-process.js';
import {AokanaMfMovieVolumePolicy} from './movie-mf-volume-policy.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** 91:F8–FB share one retained MF controller, volume policy, and wait process. */
export function createGroup91MfMovies(
  session: AokanaBrowserMfMovieSession,
  volume: AokanaMfMovieVolumePolicy,
  scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState,
  clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
  if (session.volume !== volume)
    throw new Error('Aokana MF callbacks require the session volume owner');
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  return [
    {
      primary: 0x91,
      secondary: 0xf8,
      nativeAddress: 0x1400de1d0,
      name: 'PlayFullscreenMfMovie',
      execute: (h) => {
        const rawVolume = pop32(h.thread),
          name = pointer(h),
          archive = pointer(h);
        const process = new AokanaMfMovieProcess(
          h.thread,
          procedures,
          clock,
          session,
          archive,
          name,
          rawVolume,
        );
        const node =
          h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
        if (node === null || node.state !== h.thread)
          throw new Error('Aokana MF movie thread is not linked to its scheduler');
        node.installProcess(process);
        return 2;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf9,
      nativeAddress: 0x1400de180,
      name: 'CloseFullscreenMfMovie',
      execute: (h) => {
        const status = session.release();
        push32(h.thread, status === 0 ? 0 : status === 0x80000002 ? -2 : -1);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xfa,
      nativeAddress: 0x1400de150,
      name: 'IsFullscreenMfMovieVisible',
      execute: (h) => {
        push32(h.thread, Number(session.fullscreen.suppressesOrdinaryDisplay()));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xfb,
      nativeAddress: 0x1400de0f0,
      name: 'SetFullscreenMfMovieVolume',
      execute: (h) => {
        const status = volume.applyVolume(pop32(h.thread), 1);
        push32(h.thread, status === 0 ? 0 : status === 0x80000002 ? -2 : -1);
        return 0;
      },
    },
  ];
}
