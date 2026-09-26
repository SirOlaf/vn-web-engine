import {pop32, push32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';
/** E8320/E82F0 use the actual context memory owner shared by resolver and save/GDB services. */
export function createGroup80GlobalMemory(
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x70,
      nativeAddress: 0x1400e8320,
      name: 'ConfigureGlobalMemory',
      execute: (h) => {
        const exponent = pop32(h.thread),
          result = h.memory.resizeGlobal(exponent);
        if (result === 0)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `無効なサイズ番号 [ ${exponent | 0} ] が指定されました`,
              0,
            ),
          );
        push32(h.thread, result);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x71,
      nativeAddress: 0x1400e82f0,
      name: 'ClearGlobalMemory',
      execute: (h) => {
        h.memory.clearGlobal();
        return 0;
      },
    },
  ];
}
