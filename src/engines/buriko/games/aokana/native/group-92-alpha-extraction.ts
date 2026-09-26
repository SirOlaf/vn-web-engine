import {pop32} from '../bp/state.js';
import {extractAokanaBitmapAlpha} from './bitmap-alpha-extraction.js';
import type {AokanaDisplayObjectEnvironment} from './display-object.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/**034AE0 snapshots sources before allocating the shared display-sized output slot. */
export function createGroup92AlphaExtraction(
  surfaces: AokanaSurfaces,
  environment: AokanaDisplayObjectEnvironment,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x1a,
      nativeAddress: 0x1400e4660,
      name: 'CreateDisplayAlphaMask',
      execute: (context) => {
        const level = pop32(context.thread),
          secondId = pop32(context.thread),
          firstId = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          destinationId = pop32(context.thread);
        const fatal = (message: string) =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            surfaces.fonts.text.encodeWide(message, 0),
          );
        const first = surfaces.snapshot(firstId);
        if (first === null)
          return fatal(`参照元に指定されたビットマップ [ ${firstId | 0} ] は無効です`);
        const second = secondId === 0xffffffff ? null : surfaces.snapshot(secondId);
        if (secondId !== 0xffffffff && second === null)
          return fatal(`参照元に指定されたビットマップ [ ${secondId | 0} ] は無効です`);
        const display = environment.displayBitmap();
        if (surfaces.allocate(destinationId, display.width, display.height, 3) === 0)
          return fatal(`生成先に指定されたビットマップ [ ${destinationId | 0} ] は無効です`);
        const destination = surfaces.snapshot(destinationId);
        if (destination === null)
          throw new Error('Aokana alpha extraction has no published output descriptor');
        const status = extractAokanaBitmapAlpha(destination, x, y, first, second, level);
        if (status === 1)
          return fatal(
            `参照元に指定されたビットマップ [ ${firstId | 0} ] 及び [ ${secondId | 0} ] のピクセルモードが一致しません`,
          );
        if (status !== 0)
          throw new Error('Aokana alpha extraction consumes an unwritten native status');
        return 0;
      },
    },
  ];
}
