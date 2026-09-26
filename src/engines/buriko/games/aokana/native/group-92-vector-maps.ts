import {pop32} from '../bp/state.js';
import {fillAokanaLinearVectorMap, fillAokanaRadialVectorMap} from './bitmap-vector-map.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup92VectorMaps(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const finish = (
    context: AokanaBpOpcodeContext,
    status: number,
    surface: number,
    mode: number,
  ): 0 | Promise<never> => {
    let message: string;
    if (status === 0x80000001)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] は存在しません`;
    else if (status === 0x80000003)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] はベクトル＆ディスタンスマップではない、\n\n若しくは無効なピクセル数のベクトル＆ディスタンスマップです`;
    else if (status === 0x80000009) message = `無効な波紋タイプ [ ${mode | 0} ] が指定されました`;
    else if (status === 0x8000000a) message = `無効な振動タイプ [ ${mode | 0} ] が指定されました`;
    else return 0;
    return errors.threadFatal(
      context.thread,
      context.diagnostics,
      surfaces.fonts.text.encodeWide(message, 0),
    );
  };
  return [
    {
      primary: 0x92,
      secondary: 0x10,
      nativeAddress: 0x1400e4b60,
      name: 'FillRadialVectorMap',
      execute: (context) => {
        const period = pop32(context.thread),
          centerY = pop32(context.thread),
          centerX = pop32(context.thread),
          mode = pop32(context.thread),
          surface = pop32(context.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          context,
          bitmap === null
            ? 0x80000001
            : fillAokanaRadialVectorMap(bitmap, mode, centerX, centerY, period),
          surface,
          mode,
        );
      },
    },
    {
      primary: 0x92,
      secondary: 0x11,
      nativeAddress: 0x1400e4a90,
      name: 'FillLinearVectorMap',
      execute: (context) => {
        const direction = pop32(context.thread),
          surface = pop32(context.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          context,
          bitmap === null ? 0x80000001 : fillAokanaLinearVectorMap(bitmap, direction),
          surface,
          direction,
        );
      },
    },
  ];
}
