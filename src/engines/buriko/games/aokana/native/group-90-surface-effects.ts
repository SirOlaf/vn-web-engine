import {pop32} from '../bp/state.js';
import type {AokanaSurfaceEffects} from './surface-effects.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup90SurfaceEffects(
  effects: AokanaSurfaceEffects,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(h.thread, h.diagnostics, effects.surfaces.fonts.text.encodeWide(message, 0));
  const finish = (
    h: AokanaBpOpcodeContext,
    status: number,
    messages: readonly string[],
  ): 0 | Promise<never> =>
    status >= 1 && status <= messages.length ? fatal(h, messages[status - 1]!) : 0;
  return [
    {
      primary: 0x90,
      secondary: 0x19,
      nativeAddress: 0x1400dd2c0,
      name: 'TransitionSurface',
      execute: (h) => {
        const level = pop32(h.thread),
          parameter = pop32(h.thread),
          mask = pop32(h.thread),
          source = pop32(h.thread),
          y = pop32(h.thread),
          x = pop32(h.thread),
          destination = pop32(h.thread);
        for (const value of [destination, source])
          if (value >>> 0 >= 0x4000)
            return fatal(h, `無効なビットマップ番号 [ ${value | 0} ] が指定されました`);
        if (level >>> 0 > 256)
          return fatal(
            h,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${level | 0} ] が指定されました`,
          );
        return finish(h, effects.transition(destination, x, y, source, mask, parameter, level), [
          `指定された出力先ビットマップ [ ${destination | 0} ] は存在しません`,
          `指定された出力元ビットマップ [ ${source | 0} ] は存在しません`,
          `指定された参照元グレイスケール [ ${mask | 0} ] は存在しません`,
          `出力先ビットマップ [ ${destination | 0} ] と出力元ビットマップ [ ${source | 0} ] のピクセルモードには互換性がありません`,
          `指定されたビットマップ [ ${mask | 0} ] はグレイスケールではありません`,
          `指定された参照元グレイスケール [ ${mask | 0} ] はサイズが無効です`,
        ]);
      },
    },
    {
      primary: 0x90,
      secondary: 0x1a,
      nativeAddress: 0x1400dd0d0,
      name: 'ApplySurfaceVectorMap',
      execute: (h) => {
        const bilinear = pop32(h.thread),
          level = pop32(h.thread),
          secondary = pop32(h.thread),
          primary = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        return finish(h, effects.vector(destination, source, primary, secondary, level, bilinear), [
          `格納先として指定されたビットマップ [ ${destination | 0} ] は無効です`,
          `参照元として指定されたビットマップ [ ${source | 0} ] は無効です`,
          `格納先ビットマップ [ ${destination | 0} ] と参照元ビットマップ [ ${source | 0} ] のピクセルモードが一致していません`,
          `第一ベクトルマップとして指定されたビットマップ [ ${primary | 0} ] は無効です`,
          `第一ベクトルマップとして指定されたビットマップ [ ${primary | 0} ] はベクトルマップではない、\n\n若しくは格納先ビットマップ [ ${destination | 0} ] とサイズが一致していません`,
          `第二ベクトルマップとして指定されたビットマップ [ ${secondary | 0} ] は無効です`,
          `第二ベクトルマップとして指定されたビットマップ [ ${secondary | 0} ] はベクトルマップではない、\n\n若しくは格納先ビットマップ [ ${destination | 0} ] とサイズが一致していません`,
          `無効なエフェクトレベル [ ${level | 0} ] が指定されました`,
        ]);
      },
    },
    {
      primary: 0x90,
      secondary: 0x1b,
      nativeAddress: 0x1400dcf80,
      name: 'BlurSurface',
      execute: (h) => {
        const strength = pop32(h.thread),
          selector = pop32(h.thread),
          source = pop32(h.thread),
          destination = pop32(h.thread);
        return finish(h, effects.blur(destination, source, selector, strength), [
          `格納先として指定されたビットマップ [ ${destination | 0} ] は無効です`,
          `参照元として指定されたビットマップ [ ${source | 0} ] は無効です`,
          `格納先ビットマップ [ ${destination | 0} ] と参照元ビットマップ [ ${source | 0} ] のサイズ又はピクセルモードが一致していません`,
          `無効なグラデーションタイプ [ ${selector | 0} ] が指定されました`,
          `無効なエフェクトレベル [ ${strength | 0} ] が指定されました`,
        ]);
      },
    },
  ];
}
