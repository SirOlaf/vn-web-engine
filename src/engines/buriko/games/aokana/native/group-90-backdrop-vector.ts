import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BackdropVector(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x45,
      nativeAddress: 0x1400db220,
      name: 'ConfigureVectorBackdrop',
      execute: (context) => {
        const sampling = pop32(context.thread),
          effect = pop32(context.thread),
          secondary = pop32(context.thread),
          primary = pop32(context.thread),
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
        const result = manager.configureVectorBackdrop(
          source,
          primary,
          secondary,
          effect,
          sampling,
        );
        if (result === 1 || result === 3 || result === 5)
          return fatal(
            `指定されたビットマップ [ ${(result === 1 ? source : result === 3 ? primary : secondary) | 0} ] は存在しません`,
          );
        if (result === 2)
          return fatal(
            `指定されたビットマップ [ ${source | 0} ] はスクリーンサイズと一致していません`,
          );
        if (result === 4 || result === 6)
          return fatal(
            `指定されたビットマップ [ ${(result === 4 ? primary : secondary) | 0} ] はベクトルマップではない、\n\n或いはスクリーンサイズと一致していません`,
          );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x4c,
      nativeAddress: 0x1400dac90,
      name: 'SetBackdropActivation',
      execute: (context) => {
        const content = pop32(context.thread),
          activation = pop32(context.thread);
        manager.setBackdropActivation(activation, content);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x4d,
      nativeAddress: 0x1400dac60,
      name: 'GetBackdropType',
      execute: (context) => {
        push32(context.thread, manager.backdrop.backdropType);
        return 0;
      },
    },
  ];
}
