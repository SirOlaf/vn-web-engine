import {pop32} from '../bp/state.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';
export function createGroup90SurfaceCentered(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x1c,
      nativeAddress: 0x1400dcdc0,
      name: 'StretchCenteredSurface',
      execute: (h) => {
        const sourceHeight = pop32(h.thread),
          sourceWidth = pop32(h.thread),
          sourceY = pop32(h.thread),
          sourceX = pop32(h.thread),
          source = pop32(h.thread),
          height = pop32(h.thread),
          width = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          destination = pop32(h.thread);
        const status = surfaces.stretchCenteredSurface(
          destination,
          x,
          y,
          width,
          height,
          source,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
        );
        let message: string;
        if (status === 1)
          message = `格納先として指定されたビットマップ [ ${destination | 0} ] は無効です`;
        else if (status === 2)
          message = `参照元として指定されたビットマップ [ ${source | 0} ] は無効です`;
        else if (status === 5)
          message = `無効な出力範囲 [ ${width | 0}, ${height | 0} ] が指定されました`;
        else if (status === 6)
          message = `無効な参照範囲 [ ${sourceWidth | 0}, ${sourceHeight | 0} ] が指定されました`;
        else if (status === 8)
          message = `格納先ビットマップ [ ${destination | 0} ] と参照元ビットマップ [ ${source | 0} ] のピクセルモードが一致していません`;
        else return 0;
        return errors.threadFatal(
          h.thread,
          h.diagnostics,
          surfaces.fonts.text.encodeWide(message, 0),
        );
      },
    },
    {
      primary: 0x90,
      secondary: 0x1d,
      nativeAddress: 0x1400dccb0,
      name: 'RotateCenteredSurface',
      execute: (h) => {
        const angle = pop32(h.thread),
          scale = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        const status = surfaces.rotateCenteredSurface(destination, source, scale, angle);
        let message: string;
        if (status === 1)
          message = `格納先として指定されたビットマップ [ ${destination | 0} ] は無効です`;
        else if (status === 2)
          message = `参照元として指定されたビットマップ [ ${source | 0} ] は無効です`;
        else if (status === 3)
          message = `ビットマップ [ ${destination | 0} ] とビットマップ [ ${source | 0} ] には互換性がありません`;
        else if (status === 4) message = `無効な伸縮倍率 [ ${scale | 0} ] が指定されました`;
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
