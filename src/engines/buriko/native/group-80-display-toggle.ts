import {pop32} from '../bp/state.js';
import type {BurikoDisplayController} from './display-controller.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80DisplayToggle(
  controller: BurikoDisplayController,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x62,
      nativeAddress: 0x1400e8640,
      name: 'ConfigureDisplayToggleKeys',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          enabled = pop32(h.thread);
        if (controller.configureModeToggle(enabled, source) === 0)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              'ディスプレイスタイルチェンジの対象として指定されたキーの配列が長過ぎます',
              0,
            ),
          );
        return 0;
      },
    },
  ];
}
