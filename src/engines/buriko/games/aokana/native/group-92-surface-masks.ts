import {pop32, push32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup92SurfaceMasks(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x18,
      nativeAddress: 0x1400e47e0,
      name: 'CreateSurfaceLuminanceMask',
      execute: (context) => {
        const source = pop32(context.thread),
          destination = pop32(context.thread);
        const result = surfaces.createMask(destination, source);
        if (result === 9 || result === 10) {
          const message =
            result === 9
              ? `生成元に指定されたビットマップ [ ${source | 0} ] は無効です`
              : `格納先に指定されたビットマップ [ ${destination | 0} ] は無効です`;
          return errors.threadFatal(
            context.thread,
            context.diagnostics,
            surfaces.fonts.text.encodeWide(message, 0),
          );
        }
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x19,
      nativeAddress: 0x1400e47a0,
      name: 'InvertSurfaceMask',
      execute: ({thread}) => {
        push32(thread, Number(surfaces.invertMask(pop32(thread)) === 0));
        return 0;
      },
    },
  ];
}
