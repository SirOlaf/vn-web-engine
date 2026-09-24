import {pop32} from '../bp/state.js';
import {
  fillAokanaRippleDisplacement,
  fillAokanaCurvedDisplacement,
  fillAokanaSineDisplacement,
  fillAokanaPointDisplacement,
} from './bitmap-displacement-generators.js';
import type {AokanaSurfaces} from './surfaces.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup91DisplacementGenerators(
  surfaces: AokanaSurfaces,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const finish = (
    h: AokanaBpOpcodeContext,
    status: number,
    surface: number,
    first = 0,
    second = 0,
  ): 0 | Promise<never> => {
    let message: string;
    if (status === 0x80000001)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] は存在しません`;
    else if (status === 0x80000003)
      message = `指定された出力先ビットマップ [ ${surface | 0} ] はベクトルマップではない、\n\n若しくは無効なピクセル数のベクトルマップです`;
    else if (status === 0x80000006) message = `無効な波紋の周期 [ ${first | 0} ] が指定されました`;
    else if (status === 0x80000008)
      message = `無効な湾曲度 [ ${first | 0} ] 、或いは半径 [ ${second | 0} ] が指定されました`;
    else return 0;
    return errors.threadFatal(h.thread, h.diagnostics, surfaces.fonts.text.encodeWide(message, 0));
  };
  return [
    {
      primary: 0x91,
      secondary: 0x12,
      nativeAddress: 0x1400e2500,
      name: 'FillRippleDisplacementMap',
      execute: (h) => {
        const amplitude = pop32(h.thread),
          phase = pop32(h.thread),
          period = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null
            ? 0x80000001
            : fillAokanaRippleDisplacement(bitmap, x, y, period, phase, amplitude),
          surface,
          period,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x15,
      nativeAddress: 0x1400e2240,
      name: 'FillCurvedDisplacementMap',
      execute: (h) => {
        const radius = pop32(h.thread),
          strength = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null
            ? 0x80000001
            : fillAokanaCurvedDisplacement(bitmap, x, y, strength, radius),
          surface,
          strength,
          radius,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x16,
      nativeAddress: 0x1400e2150,
      name: 'FillSineDisplacementMap',
      execute: (h) => {
        const amplitudeY = pop32(h.thread),
          phaseY = pop32(h.thread),
          periodY = pop32(h.thread),
          amplitudeX = pop32(h.thread),
          phaseX = pop32(h.thread),
          periodX = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null
            ? 0x80000001
            : fillAokanaSineDisplacement(
                bitmap,
                periodX,
                phaseX,
                amplitudeX,
                periodY,
                phaseY,
                amplitudeY,
              ),
          surface,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x17,
      nativeAddress: 0x1400e2070,
      name: 'FillPointDisplacementMap',
      execute: (h) => {
        const radius = pop32(h.thread),
          endY = pop32(h.thread),
          endX = pop32(h.thread),
          startY = pop32(h.thread),
          startX = pop32(h.thread),
          surface = pop32(h.thread);
        const bitmap = surfaces.snapshot(surface);
        return finish(
          h,
          bitmap === null
            ? 0x80000001
            : fillAokanaPointDisplacement(bitmap, startX, startY, endX, endY, radius),
          surface,
        );
      },
    },
  ];
}
