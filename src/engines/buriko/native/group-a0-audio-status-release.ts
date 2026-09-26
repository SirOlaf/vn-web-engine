import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoAudioChannels} from './audio/channel-registry.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';
// Exact CP932 prefixes at186BF0/186C28/186C98; the native formatter uses signed %d.
const music = [
  150, 179, 140, 248, 130, 200, 137, 185, 138, 121, 131, 96, 131, 131, 131, 147, 131, 108, 131, 139,
  148, 212, 141, 134,
];
const sound = [150, 179, 140, 248, 130, 200, 140, 248, 137, 202, 137, 185, 148, 212, 141, 134];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

export function createGroupA0AudioStatusRelease(
  channels: BurikoAudioChannels,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  const fatal = (h: BurikoBpOpcodeContext, prefix: number[], value: number) =>
    errors.threadFatal(
      h.thread,
      h.diagnostics,
      Uint8Array.from([...prefix, ...new TextEncoder().encode(` [ ${value | 0} ] `), ...suffix]),
    );
  return [
    {
      primary: 0xa0,
      secondary: 0x15,
      nativeAddress: 0x1400e5990,
      name: 'GetStreamPlayingAndLoops',
      execute: async (h): Promise<0> => {
        const output = h.memory.resolve(h.thread, pop32(h.thread)),
          channel = pop32(h.thread);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        const playing = await channels.streamStatus(
          channel,
          output === null ? null : (value) => pointerView(output, 4).setInt32(0, value, true),
          h.actor,
        );
        push32(h.thread, playing);
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x22,
      nativeAddress: 0x1400e55a0,
      name: 'ReleaseStaticSound',
      execute: async (h): Promise<0> => {
        const channel = pop32(h.thread);
        if (channel >>> 0 >= channels.staticCapacity) return fatal(h, sound, channel);
        await channels.releaseStatic(channel, h.actor);
        return 0;
      },
    },
  ];
}
