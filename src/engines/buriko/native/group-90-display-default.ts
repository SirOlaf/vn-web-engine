import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** 90:3F uses actual virtualD8; verified native families report unsupported image caching. */
export function createGroup90DisplayDefault(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x3f,
      nativeAddress: 0x1400db8d0,
      name: 'RunObjectDefaultOperation',
      execute: (context) => {
        const status = manager.runObjectDefaultOperation(pop32(context.thread));
        if (status === 0) return 0;
        const message =
          status === 3
            ? '指定されたディスプレイオブジェクトはイメージキャッシュをサポートしていません'
            : status === 4
              ? '指定されたディスプレイオブジェクトは無効なイメージサイズが設定されています'
              : '無効なオブジェクトハンドルが指定されました';
        return errors.threadFatal(
          context.thread,
          context.diagnostics,
          errors.files.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
