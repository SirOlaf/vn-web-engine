import {pop32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BackdropStretch(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x48,
      nativeAddress: 0x1400daea0,
      name: 'ConfigureStretchBackdrop',
      execute: (context) => {
        const height = pop32(context.thread),
          width = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          source = pop32(context.thread);
        const result = manager.configureStretchBackdrop(source, x, y, width, height);
        if (result !== 1 && result !== 2) return 0;
        const message =
          result === 1
            ? `指定されたビットマップ [ ${source | 0} ] は存在しません`
            : `無効な参照範囲 [ ${width | 0} , ${height | 0} ] が指定されました`;
        return errors.threadFatal(
          context.thread,
          context.diagnostics,
          errors.files.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
