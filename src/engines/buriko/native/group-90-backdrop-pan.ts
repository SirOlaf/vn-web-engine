import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup90BackdropPan(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x42,
      nativeAddress: 0x1400db6d0,
      name: 'ConfigurePanBackdrop',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          fourth = pop32(context.thread),
          third = pop32(context.thread),
          second = pop32(context.thread),
          first = pop32(context.thread);
        const result = manager.configurePanBackdrop(first, second, third, fourth, x, y);
        const message =
          result === 1
            ? `背景（Sモード）に対して無効な表示座標 [ ${x | 0} , ${y | 0} ] が指定されました`
            : result === 2
              ? `指定されたビットマップ [ ${first | 0} , ${second | 0} , ${third | 0} , ${fourth | 0} ] のいずれかは存在しないか、背景には使用できません`
              : null;
        return message === null
          ? 0
          : errors.threadFatal(
              context.thread,
              context.diagnostics,
              errors.files.text.encodeWide(message, 0),
            );
      },
    },
  ];
}
