import {pop32} from '../bp/state.js';
import {
  fillAokanaScaledDisplacementMap,
  fillAokanaRandomDisplacementMap,
} from './bitmap-displacement-map.js';
import type {AokanaCrtRandom} from './system-timing.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup91DisplacementMaps(
  surfaces: AokanaSurfaces,
  random: AokanaCrtRandom,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const finish = (
    h: AokanaBpOpcodeContext,
    status: number,
    surface: number,
    width = 0,
    height = 0,
  ): 0 | Promise<never> => {
    let message: string;
    if (status === 0x80000001)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] は存在しません`;
    else if (status === 0x80000003)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] はベクトルマップではない、\n\n若しくは無効なピクセル数のベクトルマップです`;
    else if (status === 0x80000005)
      message = `無効な伸縮範囲 [ ${width | 0} , ${height | 0} ] が指定されました`;
    else return 0;
    return errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
  };
  return [
    {
      primary: 0x91,
      secondary: 0x10,
      nativeAddress: 0x1400e26b0,
      name: 'FillScaledDisplacementMap',
      execute: (h) => {
        const height = pop32(h.thread),
          width = pop32(h.thread),
          offsetY = pop32(h.thread),
          offsetX = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null
            ? 0x80000001
            : fillAokanaScaledDisplacementMap(bitmap, offsetX, offsetY, width, height),
          surface,
          width,
          height,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x11,
      nativeAddress: 0x1400e2610,
      name: 'FillRandomDisplacementMap',
      execute: (h) => {
        const radius = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null ? 0x80000001 : fillAokanaRandomDisplacementMap(bitmap, radius, random),
          surface,
        );
      },
    },
  ];
}
