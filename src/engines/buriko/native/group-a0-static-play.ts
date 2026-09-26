import {pop32, push32} from '../bp/state.js';
import type {BurikoAudioStaticResources} from './audio/resource-static.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

const pan = [
  150, 179, 140, 248, 130, 200, 131, 112, 131, 147, 131, 124, 131, 98, 131, 103, 129, 105, 146, 232,
  136, 202, 129, 106,
];
const volume = [
  150, 179, 140, 248, 130, 200, 131, 123, 131, 138, 131, 133, 129, 91, 131, 128, 129, 105, 137, 185,
  151, 202, 129, 106,
];
const sound = [150, 179, 140, 248, 130, 200, 140, 248, 137, 202, 137, 185, 148, 212, 141, 134];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

/** E5420 uses separate engine2 admissions for F5D80 start and F5840 duration. */
export function createGroupA0StaticPlay(
  resources: BurikoAudioStaticResources,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0x24,
      nativeAddress: 0x1400e5420,
      name: 'PlayStaticSoundAndGetDuration',
      execute: async (h): Promise<0> => {
        const channels = resources.channels,
          actor = h.actor ?? channels.actors.currentActor,
          position = pop32(h.thread),
          level = pop32(h.thread),
          channel = pop32(h.thread);
        const fatal = (prefix: number[], value: number) =>
          errors.threadFatal(
            h.thread,
            h.diagnostics,
            Uint8Array.from([
              ...prefix,
              ...new TextEncoder().encode(` [ ${value | 0} ] `),
              ...suffix,
            ]),
          );
        if (position >>> 0 > 128) return fatal(pan, position);
        if (level >>> 0 > 128) return fatal(volume, level);
        if (channel >>> 0 >= resources.channels.staticCapacity) return fatal(sound, channel);
        const result = await channels.withEngineControl(
          () => channels.startStatic(channel, level, position, actor),
          actor,
        );
        push32(
          h.thread,
          result === 0 || result === 20 ? await resources.duration(channel, actor) : 0,
        );
        return 0;
      },
    },
  ];
}
