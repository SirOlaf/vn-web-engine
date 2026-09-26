import {pop32, push32} from '../bp/state.js';
import {BurikoNativeText} from './text.js';
import {
  copyBurikoBitmapGroupDescription,
  formatBurikoBitmapGroups,
} from './bitmap-group-description.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroupE0BitmapDescription(
  text: BurikoNativeText,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xe0,
      secondary: 0x3f,
      nativeAddress: 0x1400ab680,
      name: 'FormatBitmapGroupDescription',
      execute: (h) => {
        const source = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const result = copyBurikoBitmapGroupDescription(source, h.memory, h.thread);
        push32(
          h.thread,
          result.result === 0
            ? formatBurikoBitmapGroups(output, result.description, text)
            : 0xffffffff,
        );
        return 0;
      },
    },
  ];
}
