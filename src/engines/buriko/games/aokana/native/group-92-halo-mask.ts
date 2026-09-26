import {pop32} from '../bp/state.js';
import {createAokanaHaloMask} from './bitmap-halo-mask.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup92HaloMask(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x92,
      secondary: 0x1b,
      nativeAddress: 0x1400e4530,
      name: 'CreateAlphaHaloMask',
      execute: (context) => {
        const radius = pop32(context.thread),
          sourceId = pop32(context.thread),
          destinationId = pop32(context.thread);
        const fatal = (message: string) =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            surfaces.fonts.text.encodeWide(message, 0),
          );
        const source = surfaces.snapshot(sourceId);
        if (source === null)
          return fatal(`参照元に指定されたビットマップ [ ${sourceId | 0} ] は無効です`);
        if ((radius - 1) >>> 0 > 2)
          return fatal(`無効な輪郭の幅 [ ${radius | 0} ] が指定されました`);
        if (
          surfaces.allocate(destinationId, (source.width + 16) | 0, (source.height + 16) | 0, 3) ===
          0
        )
          return fatal(`生成先に指定されたビットマップ [ ${destinationId | 0} ] は無効です`);
        const destination = surfaces.snapshot(destinationId);
        if (destination === null)
          throw new Error('Aokana halo mask has no published output descriptor');
        const status = createAokanaHaloMask(destination, source, radius, surfaces.compositor);
        if (status === 0x15) {
          // E4530 copies the live source descriptor again after allocation before its diagnostic.
          const current = surfaces.snapshot(sourceId);
          if (current === null)
            throw new Error('Aokana halo diagnostic consumes an unwritten source format');
          return fatal(
            `参照元に指定されたビットマップ [ ${sourceId | 0} ] のピクセルモード [ 0x${(current.format >>> 0).toString(16).toUpperCase()} ] はサポートされていません`,
          );
        }
        // 0349E0 maps other nonzero statuses toFFFFFFFF, which the wrapper ignores.
        return 0;
      },
    },
  ];
}
