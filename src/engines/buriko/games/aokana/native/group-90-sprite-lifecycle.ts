import {pop32, push32} from '../bp/state.js';
import type {AokanaDisplayManager} from './display-manager.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaSpriteTargets} from './sprite-targets.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Literal lifecycle wrappers over actual display pools, Sprite masks and input targets. */
export function createGroup90SpriteLifecycle(
  manager: AokanaDisplayManager,
  targets: AokanaSpriteTargets,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(
      context.thread,
      context.diagnostics,
      errors.files.text.encodeWide(message, 0),
    );
  const invalidSprite = '無効なスプライトハンドルが指定されました';
  return [
    {
      primary: 0x90,
      secondary: 0x50,
      nativeAddress: 0x1400dac20,
      name: 'CreateSprite',
      execute: (context) => {
        const handle = manager.createSprite();
        if (handle === 0)
          return fatal(context, 'これ以上、スプライトオブジェクトを生成する事は出来ません');
        push32(context.thread, handle);
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x51,
      nativeAddress: 0x1400daba0,
      name: 'DestroySprite',
      execute: (context) => {
        const handle = pop32(context.thread);
        targets.unregister(handle);
        if (manager.resolve(handle)?.getOwner() != null)
          return fatal(context, '指定されたスプライトには協調しているプロシージャが存在します');
        if (manager.resolve(handle)?.parent != null)
          return fatal(context, '指定されたスプライトにはオーナーが存在します');
        return manager.destroy('sprite', handle) ? 0 : fatal(context, invalidSprite);
      },
    },
    {
      primary: 0x90,
      secondary: 0x54,
      nativeAddress: 0x1400daac0,
      name: 'SetSpriteActivation',
      execute: (context) => {
        const activation = pop32(context.thread),
          handle = pop32(context.thread);
        return manager.setSpriteActivation(handle, activation) ? 0 : fatal(context, invalidSprite);
      },
    },
    {
      primary: 0x90,
      secondary: 0x55,
      nativeAddress: 0x1400daa10,
      name: 'SetSpriteStaticMask',
      execute: (context) => {
        const surface = pop32(context.thread),
          handle = pop32(context.thread);
        const status = manager.setSpriteStaticMask(handle, surface);
        if (status === -1) return fatal(context, invalidSprite);
        if (status === 1)
          return fatal(context, `無効なビットマップ [ ${surface | 0} ] が指定されました`);
        if (status === 2)
          return fatal(
            context,
            `ビットマップ [ ${surface | 0} ] はスクリーンサイズのグレイスケールではありません`,
          );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x81,
      nativeAddress: 0x1400d9230,
      name: 'DestroyWindow',
      execute: (context) => {
        const handle = pop32(context.thread);
        if (manager.resolve(handle)?.getOwner() != null)
          return fatal(context, '指定されたウィンドウには協調しているプロシージャが存在します');
        if (manager.resolve(handle)?.parent != null)
          return fatal(context, '指定されたウィンドウにはオーナーが存在します');
        return manager.destroy('window', handle)
          ? 0
          : fatal(context, '無効なウィンドウハンドルが指定されました');
      },
    },
  ];
}
