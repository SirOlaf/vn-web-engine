import {pop32} from '../bp/state.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup90ToneCurves(
  surfaces: BurikoSurfaces,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, message: string) => {
    const encoded = surfaces.fonts.text.encodeWide(message, 0);
    if (encoded.length > 256) throw new RangeError('Buriko tone diagnostic exceeds native scratch');
    return errors.threadFatal(h.thread, h.diagnostics, encoded);
  };
  return [
    {
      primary: 0x90,
      secondary: 0xcc,
      nativeAddress: 0x1400d7200,
      name: 'ConfigureToneCurve',
      execute: (h) => {
        const pointer = h.memory.resolve(h.thread, pop32(h.thread)),
          key = pop32(h.thread),
          result = surfaces.toneCurves.configure(key, pointer);
        if (result === 0x8000000f)
          return fatal(h, `登録先に指定されたトーンカーブの識別番号 [ ${key | 0} ] は無効です`);
        if (result === 0x80000010)
          return fatal(
            h,
            `識別番号 [ ${key | 0} ] に登録しようとしたトーンカーブの経由座標の中に無効なものが含まれています`,
          );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xcd,
      nativeAddress: 0x1400d7000,
      name: 'ApplyToneCurve',
      execute: (h) => {
        const filmLevel = pop32(h.thread),
          filmMode = pop32(h.thread),
          film = pop32(h.thread),
          key = pop32(h.thread),
          monoLevel = pop32(h.thread),
          monochrome = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread),
          result = surfaces.applyToneCurve(
            destination,
            source,
            monochrome,
            monoLevel,
            key,
            film,
            filmMode,
            filmLevel,
          );
        switch (result) {
          case 0x80000009:
            return fatal(h, `出力先に指定されたビットマップ [ ${destination | 0} ] は無効です`);
          case 0x8000000a:
            return fatal(h, `参照元に指定されたビットマップ [ ${source | 0} ] は無効です`);
          case 0x8000000f:
            return fatal(h, `無効なトーンカーブの識別番号 [ ${key | 0} ] が指定されました`);
          case 0x80000011:
            return fatal(
              h,
              `指定されたビットマップ [ ${source | 0} ] のピクセルモードはサポートされていません`,
            );
          case 0x80000013:
            return fatal(
              h,
              `指定されたエフェクトモード [ ${filmMode | 0} ] はサポートされていません`,
            );
          case 0x80000014:
            return fatal(
              h,
              `無効なカラーフィルムの混合レベル [ ${filmLevel | 0} ] が指定されました`,
            );
          case 0x80000015:
            return fatal(
              h,
              `無効なモノクロイメージの混合レベル [ ${monoLevel | 0} ] が指定されました`,
            );
        }
        return 0;
      },
    },
  ];
}
