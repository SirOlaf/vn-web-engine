import {pop32, push32} from '../bp/state.js';
import type {BurikoAudioStaticResources} from './audio/resource-static.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

// Exact CP932186C98 and signed decimal substitution used by FCA80.
const sound = [150, 179, 140, 248, 130, 200, 140, 248, 137, 202, 137, 185, 148, 212, 141, 134];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

export function createGroupA0StaticDuration(
  resources: BurikoAudioStaticResources,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0x2f,
      nativeAddress: 0x1400e50f0,
      name: 'GetStaticSoundDuration',
      execute: async (h): Promise<0> => {
        const channel = pop32(h.thread);
        if (channel >>> 0 >= resources.channels.staticCapacity)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            Uint8Array.from([
              ...sound,
              ...new TextEncoder().encode(` [ ${channel | 0} ] `),
              ...suffix,
            ]),
          );
        push32(h.thread, await resources.duration(channel, h.actor));
        return 0;
      },
    },
  ];
}
