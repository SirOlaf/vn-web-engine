import {pop32, push32} from '../bp/state.js';
import type {BurikoNativeText} from './text.js';
import {collectBurikoRawLinks, stripBurikoTextTags} from './text-tags.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/**DE7F0/DE7B0 use native encoded substring search and actual overlapping byte pointers. */
export function createGroup91TextTags(text: BurikoNativeText): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x91,
      secondary: 0x9e,
      nativeAddress: 0x1400de7f0,
      name: 'CollectRawTextLinks',
      execute: (context) => {
        const source = context.memory.resolve(context.thread, pop32(context.thread)),
          output = context.memory.resolve(context.thread, pop32(context.thread));
        push32(context.thread, collectBurikoRawLinks(text, output, source));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x9f,
      nativeAddress: 0x1400de7b0,
      name: 'StripTextTags',
      execute: (context) => {
        const source = context.memory.resolve(context.thread, pop32(context.thread)),
          output = context.memory.resolve(context.thread, pop32(context.thread));
        stripBurikoTextTags(text, output, source);
        return 0;
      },
    },
  ];
}
