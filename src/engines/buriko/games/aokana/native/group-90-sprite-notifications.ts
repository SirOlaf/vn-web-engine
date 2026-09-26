import {pop32} from '../bp/state.js';
import {AokanaDisplayManager} from './display-manager.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Bank 90:53, the explicit five-argument sprite source-region notification path. */
export function createGroup90SpriteNotifications(
  manager: AokanaDisplayManager,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  return [
    {
      primary: 0x90,
      secondary: 0x53,
      nativeAddress: 0x1400dab10,
      name: 'NotifySpriteSourceRegionChanged',
      execute: (context) => {
        const height = pop32(context.thread),
          width = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          handle = pop32(context.thread),
          result = manager.notifySpriteSourceRegionChanged(handle, x, y, width, height);
        if (result === 10) return fatal(context, '無効な更新領域情報が指定されました');
        if (result === 0xffffffff)
          return fatal(context, '無効なスプライトハンドルが指定されました');
        return 0;
      },
    },
  ];
}
