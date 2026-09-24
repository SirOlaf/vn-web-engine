import {pop32} from '../bp/state.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup91SurfaceSplat(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x1b,
      nativeAddress: 0x1400e1b70,
      name: 'AccumulateContractedSurface',
      execute: (h) => {
        const level = pop32(h.thread),
          scaleY = pop32(h.thread),
          scaleX = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread),
          status = surfaces.splatSurface(destination, source, scaleX, scaleY, level);
        let message: string;
        if (status === 1)
          message = `指定された出力先ビットマップ [ ${destination | 0} ] は無効です`;
        else if (status === 2)
          message = `指定された参照元ビットマップ [ ${source | 0} ] は無効です`;
        else if (status === 4)
          message = `指定された集合度 [ ${scaleX | 0} ／ ${scaleY | 0} ] は無効です`;
        else if (status === 5) message = `指定された輝度減衰量 [ ${level | 0} ] は無効です`;
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
