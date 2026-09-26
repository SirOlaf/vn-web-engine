import {pop32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BackdropRotation(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x49,
      nativeAddress: 0x1400dadf0,
      name: 'ConfigureRotationBackdrop',
      execute: (context) => {
        const angle = pop32(context.thread),
          scale = pop32(context.thread),
          source = pop32(context.thread);
        const result = manager.configureRotationBackdrop(source, scale, angle);
        if (result !== 1 && result !== 2) return 0;
        const message =
          result === 1
            ? `指定されたビットマップ [ ${source | 0} ] は存在しません`
            : `無効な伸縮倍率 [ ${scale | 0} ] が指定されました`;
        return errors.threadFatal(
          context.thread,
          context.diagnostics,
          errors.files.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
