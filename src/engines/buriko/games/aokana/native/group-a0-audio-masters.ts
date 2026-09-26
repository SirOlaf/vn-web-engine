import {pop32, push32} from '../bp/state.js';
import type {AokanaAudioChannels} from './audio/channel-registry.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

// Exact CP932 prefixes at186BF0/186C28/186C98; the native formatter uses signed %d.
const music = [
  150, 179, 140, 248, 130, 200, 137, 185, 138, 121, 131, 96, 131, 131, 131, 147, 131, 108, 131, 139,
  148, 212, 141, 134,
];
const volume = [
  150, 179, 140, 248, 130, 200, 131, 123, 131, 138, 131, 133, 129, 91, 131, 128, 129, 105, 137, 185,
  151, 202, 129, 106,
];
const sound = [150, 179, 140, 248, 130, 200, 140, 248, 137, 202, 137, 185, 148, 212, 141, 134];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

/** E5E90/E5E30/E5DD0 operate on the same persistent arrays and concrete voices. */
export function createGroupA0AudioMasters(
  channels: AokanaAudioChannels,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (h: AokanaBpOpcodeContext, prefix: number[], value: number) =>
    errors.threadFatal(
      h.thread,
      h.diagnostics,
      Uint8Array.from([...prefix, ...new TextEncoder().encode(` [ ${value | 0} ] `), ...suffix]),
    );
  return [
    {
      primary: 0xa0,
      secondary: 0x00,
      nativeAddress: 0x1400e5e90,
      name: 'PushAudioConstant20',
      execute: (h) => {
        push32(h.thread, 20);
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x08,
      nativeAddress: 0x1400e5e30,
      name: 'SetStreamMasterVolume',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread),
          channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, volume, value);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.setPersistentMaster(true, channel, value, h.actor);
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x09,
      nativeAddress: 0x1400e5dd0,
      name: 'SetStaticMasterVolume',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread),
          channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, volume, value);
        if (channel >>> 0 >= 128) return fatal(h, sound, channel);
        await channels.setPersistentMaster(false, channel, value, h.actor);
        return 0;
      },
    },
  ];
}
