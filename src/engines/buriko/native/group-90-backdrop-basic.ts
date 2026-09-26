import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup90BackdropBasic(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (context: BurikoBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  return [
    {
      primary: 0x90,
      secondary: 0x40,
      nativeAddress: 0x1400db870,
      name: 'ConfigureNormalBackdrop',
      execute: (context) => {
        const surface = pop32(context.thread);
        return manager.configureNormalBackdrop(surface) !== 0
          ? 0
          : fatal(
              context,
              `指定されたビットマップ [ ${surface | 0} ] は存在しないか、背景には使用できません`,
            );
      },
    },
    {
      primary: 0x90,
      secondary: 0x41,
      nativeAddress: 0x1400db7d0,
      name: 'ConfigureBlendBackdrop',
      execute: (context) => {
        const blend = pop32(context.thread),
          second = pop32(context.thread),
          first = pop32(context.thread);
        if (blend > 0x100)
          return fatal(
            context,
            `無効なエフェクトレベル／トランスペアレンシィ／オパシティ／アディションレベル [ ${blend | 0} ] が指定されました`,
          );
        return manager.configureBlendBackdrop(first, second, blend) !== 0
          ? 0
          : fatal(
              context,
              `指定されたビットマップ [ ${first | 0} , ${second | 0} ] のいずれかは存在しないか、背景には使用できません`,
            );
      },
    },
  ];
}
