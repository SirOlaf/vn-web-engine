import {pop32} from '../bp/state.js';
import type {AokanaCursorShapes} from './cursor-shapes.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup80CursorShapes(
  shapes: AokanaCursorShapes,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
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
