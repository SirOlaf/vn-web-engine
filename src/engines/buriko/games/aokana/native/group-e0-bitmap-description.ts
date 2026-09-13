import {pop32, push32} from '../bp/state.js';
import {AokanaNativeText} from './text.js';
import {
  copyAokanaBitmapGroupDescription,
  formatAokanaBitmapGroups,
} from './bitmap-group-description.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroupE0BitmapDescription(
  text: AokanaNativeText,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x3f,
      nativeAddress: 0x1400ab680,
      name: 'FormatBitmapGroupDescription',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const result = copyAokanaBitmapGroupDescription(source, h.memory, h.thread);
        push32(
          h.thread,
          result.result === 0
            ? formatAokanaBitmapGroups(output, result.description, text)
            : 0xffffffff,
        );
        return 0;
      },
    },
  ];
}
