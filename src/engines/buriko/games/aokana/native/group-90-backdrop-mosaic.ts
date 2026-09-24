import {pop32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup90BackdropMosaic(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x4a,
      nativeAddress: 0x1400dacc0,
      name: 'ConfigureMosaicBackdrop',
      execute: (context) => {
        const enabled = pop32(context.thread),
          level = pop32(context.thread),
          selector = pop32(context.thread),
          second = pop32(context.thread),
          first = pop32(context.thread);
        const result = manager.configureMosaicBackdrop(first, second, selector, level, enabled);
        let message: string;
        if (result === 1)
          message = `指定された表側ビットマップ [ ${first | 0} ] は存在しないか、背景には使用できません`;
        else if (result === 2)
          message = `指定された裏側ビットマップ [ ${second | 0} ] は存在しないか、背景には使用できません`;
        else if (result === 3) message = `無効なスタイル [ ${selector | 0} ] が指定されました`;
        else if (result === 4) message = `無効な連動状態 [ ${enabled | 0} ] が指定されました`;
        else return 0;
        return errors.threadFatal(
          context.thread,
          context.diagnostics,
          errors.files.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
