import {pop32} from '../bp/state.js';
import type {BurikoCursorShapes} from './cursor-shapes.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80CursorShapes(
  shapes: BurikoCursorShapes,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x67,
      nativeAddress: 0x1400e8500,
      name: 'SelectCursorShape',
      execute: (h) => {
        const index = pop32(h.thread);
        if (index >= 5)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `指定されたマウスカーソル形状番号 [ ${index | 0} ] は無効です`,
              0,
            ),
          );
        shapes.select(index);
        return 0;
      },
    },
  ];
}
