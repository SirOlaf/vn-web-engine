import {pop32, push32} from '../bp/state.js';
import type {BurikoImportedTextMaps} from './imported-text-maps.js';
import {copyText, textLength} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup81ImportedText(
  maps: BurikoImportedTextMaps,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xd8,
      nativeAddress: 0x1400eaa50,
      name: 'ImportTextMaps',
      execute: (h) => {
        const size = pop32(h.thread),
          input = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, Number(maps.import(input, size)));
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xda,
      nativeAddress: 0x1400ea9b0,
      name: 'ReadImportedText',
      execute: (h) => {
        const key = h.memory.resolve(h.thread, pop32(h.thread)),
          group = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const value = maps.lookup(group, key);
        if (value !== null && output !== null) copyText(output, value);
        push32(h.thread, value === null ? 0 : textLength(value));
        return 0;
      },
    },
  ];
}
