import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup90BackdropMask(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x43,
      nativeAddress: 0x1400db520,
      name: 'ConfigureMaskedBackdrop',
      execute: (context) => {
        const blend = pop32(context.thread),
          parameter = pop32(context.thread),
          mask = pop32(context.thread),
          second = pop32(context.thread),
          secondY = pop32(context.thread),
          secondX = pop32(context.thread),
          first = pop32(context.thread),
          firstY = pop32(context.thread),
          firstX = pop32(context.thread);
        const fatal = (message: string): Promise<never> =>
          errors.threadFatal(
            context.thread,
            context.diagnostics,
            errors.files.text.encodeWide(message, 0),
          );
        if (blend > 256)
          return fatal(
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
          );
        const result = manager.configureMaskedBackdrop(
          firstX,
          firstY,
          first,
          secondX,
          secondY,
          second,
          mask,
          parameter,
          blend,
        );
        if (result === 1 || result === 2 || result === 3)
          return fatal(
            `指定されたビットマップ [ ${(result === 1 ? first : result === 2 ? second : mask) | 0} ] は存在しません`,
          );
        if (result === 4)
          return fatal(`指定されたビットマップ [ ${mask | 0} ] はグレイスケールではありません`);
        if (result === 5)
          return fatal(`指定されたグレイスケールビットマップ [ ${mask | 0} ] は相応しくありません`);
        return 0;
      },
    },
  ];
}
