import {pop32} from '../bp/state.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {fitBurikoSurfaceAspect} from './surface-aspect-fit.js';

export function createGroup90AspectFit(
  surfaces: BurikoSurfaces,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0xca,
      nativeAddress: 0x1400d72a0,
      name: 'FitSurfaceAspect',
      execute: (h) => {
        const source = pop32(h.thread),
          destination = pop32(h.thread);
        const status = fitBurikoSurfaceAspect(surfaces, destination, source);
        if (status === 0x80000009 || status === 0x8000000a) {
          const message =
            status === 0x80000009
              ? `出力先に指定されたビットマップ [ ${destination | 0} ] は無効です`
              : `参照元に指定されたビットマップ [ ${source | 0} ] は無効です`;
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            surfaces.fonts.text.encodeWide(message, 0),
          );
        }
        return 0;
      },
    },
  ];
}
