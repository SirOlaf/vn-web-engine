import {pop32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BackdropBlur(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x46,
      nativeAddress: 0x1400db130,
      name: 'ConfigureBlurBackdrop',
      execute: (context) => {
        const effect = pop32(context.thread),
          selector = pop32(context.thread),
          source = pop32(context.thread);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            errors.files.text.encodeWide(message, 0),
          );
        if (effect > 256)
          return fatal(
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${effect | 0} ] が指定されました`,
          );
        const status = manager.configureBlurBackdrop(source, selector, effect);
        if (status === 1) return fatal(`指定されたビットマップ [ ${source | 0} ] は存在しません`);
        if (status === 2)
          return fatal(
            `指定されたビットマップ [ ${source | 0} ] はスクリーンサイズと一致していません`,
          );
        if (status === 3)
          return fatal(`無効なグラデーションタイプ [ ${selector | 0} ] が指定されました`);
        return 0;
      },
    },
  ];
}
