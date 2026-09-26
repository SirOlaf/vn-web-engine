import {pop32} from '../bp/state.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';
export function createGroup91SurfaceScale(
  surfaces: BurikoSurfaces,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x1c,
      nativeAddress: 0x1400e1a40,
      name: 'ScaleSurface',
      execute: (h) => {
        const sampling = pop32(h.thread),
          scaleY = pop32(h.thread),
          scaleX = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        const status = surfaces.scaleSurface(destination, source, scaleX, scaleY, sampling);
        let message: string;
        if (status === 1)
          message = `指定された格納先ビットマップ [ ${destination | 0} ] は無効です`;
        else if (status === 2)
          message = `指定された参照元ビットマップ [ ${source | 0} ] は無効です`;
        else if (status === 3)
          message = `指定された参照元ビットマップ [ ${source | 0} ] はTRUECOLORではありません`;
        else if (status === 4)
          message = `無効なストレッチレート [ ${scaleX | 0} , ${scaleY | 0} ] は無効です`;
        else return 0;
        return errors.threadFatal(
          h.thread,
          h.diagnostics,
          surfaces.fonts.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
