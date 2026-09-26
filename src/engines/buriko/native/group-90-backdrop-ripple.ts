import {pop32} from '../bp/state.js';
import {BurikoDisplayManager} from './display-manager.js';
import {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

/** Bank 90:47, the complete type-eight CDspObjBackRPL configuration wrapper. */
export function createGroup90RippleBackdrop(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, errors.files.text.encodeWide(message, 0));
  return [
    {
      primary: 0x90,
      secondary: 0x47,
      nativeAddress: 0x1400daf70,
      name: 'ConfigureRippleBackdrop',
      execute: (h) => {
        const blend = pop32(h.thread),
          coefficientSlot = pop32(h.thread),
          gradientCount = pop32(h.thread),
          mapSurface = pop32(h.thread),
          sourceSurface = pop32(h.thread);
        if (blend >>> 0 > 0x100)
          return fatal(
            h,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
          );
        switch (
          manager.configureRippleBackdrop(
            sourceSurface,
            mapSurface,
            gradientCount,
            coefficientSlot,
            blend,
          )
        ) {
          case 1:
            return fatal(h, `指定されたビットマップ [ ${sourceSurface | 0} ] は存在しません`);
          case 2:
            return fatal(
              h,
              `指定されたビットマップ [ ${sourceSurface | 0} ] はスクリーンサイズと一致していません`,
            );
          case 3:
            return fatal(
              h,
              `指定されたベクトル＆ディスタンスマップ [ ${mapSurface | 0} ] は存在しません`,
            );
          case 4:
            return fatal(
              h,
              `指定されたビットマップ [ ${mapSurface | 0} ] はベクトル＆ディスタンスマップではない、或いはスクリーンサイズとピクセル数が一致していません`,
            );
          case 5:
            return fatal(h, `無効なグラデーションタイプ [ ${gradientCount | 0} ] が指定されました`);
          case 6:
            return fatal(h, `指定された波紋 [ ${coefficientSlot | 0} ] は登録されていません`);
          case 7:
            return fatal(
              h,
              `指定された波紋 [ ${coefficientSlot | 0} ] はベクトル＆ディスタンスマップ [ ${mapSurface | 0} ] に適合しません`,
            );
          default:
            return 0;
        }
      },
    },
  ];
}
