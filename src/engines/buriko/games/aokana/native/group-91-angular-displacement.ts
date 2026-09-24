import {pop32} from '../bp/state.js';
import {fillAokanaAngularProjection, fillAokanaAngularBend} from './bitmap-angular-displacement.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';
export function createGroup91AngularDisplacement(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const execute = (h: AokanaBpOpcodeContext, bend: boolean): 0 | Promise<never> => {
    const radius = pop32(h.thread),
      angle = pop32(h.thread),
      y = pop32(h.thread),
      x = pop32(h.thread),
      surface = pop32(h.thread);
    const bitmap = surfaces.snapshot(surface);
    const status =
      bitmap === null
        ? 0x80000001
        : (bend ? fillAokanaAngularBend : fillAokanaAngularProjection)(bitmap, x, y, angle, radius);
    let message: string;
    if (status === 0x80000001)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] は存在しません`;
    else if (status === 0x80000003)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] はベクトルマップではない、\n\n若しくは無効なピクセル数のベクトルマップです`;
    else if (bend && status === 0x80000008)
      message = `無効な湾曲角度 [ ${angle | 0} ] 、或いは半径 [ ${radius | 0} ] が指定されました`;
    else return 0;
    return errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
  };
  return [
    {
      primary: 0x91,
      secondary: 0x13,
      nativeAddress: 0x1400e2440,
      name: 'FillAngularProjectionMap',
      execute: (h) => execute(h, false),
    },
    {
      primary: 0x91,
      secondary: 0x14,
      nativeAddress: 0x1400e2340,
      name: 'FillAngularBendMap',
      execute: (h) => execute(h, true),
    },
  ];
}
