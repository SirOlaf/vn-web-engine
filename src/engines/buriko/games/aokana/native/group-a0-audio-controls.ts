import {pop32} from '../bp/state.js';
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

const pan = [
  150, 179, 140, 248, 130, 200, 131, 112, 131, 147, 131, 124, 131, 98, 131, 103, 129, 105, 146, 232,
  136, 202, 129, 106,
];
export function createGroupA0AudioControls(
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
      secondary: 0x14,
      nativeAddress: 0x1400e59f0,
      name: 'SetStreamResume',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.pauseStream(channel, Number(value === 0), actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x16,
      nativeAddress: 0x1400e5900,
      name: 'FadeStreamVolume',
      execute: async (h): Promise<0> => {
        const duration = pop32(h.thread);
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, volume, value);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.fadeStream(channel, value, duration, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x17,
      nativeAddress: 0x1400e5890,
      name: 'SetStreamPan',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, pan, value);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.panStream(channel, value, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x18,
      nativeAddress: 0x1400e5830,
      name: 'FadeStreamEnvelopeIn',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.fadeEnvelope(true, channel, 128, value, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x19,
      nativeAddress: 0x1400e57d0,
      name: 'FadeStreamEnvelopeOut',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.fadeEnvelope(true, channel, 0, value, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x1c,
      nativeAddress: 0x1400e5760,
      name: 'SetStreamAdditionalVolume',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, volume, value);
        if (channel >>> 0 >= 16) return fatal(h, music, channel);
        await channels.withEngineControl(
          (actor) => channels.setAdditional(true, channel, value, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x25,
      nativeAddress: 0x1400e53f0,
      name: 'StopStaticSound',
      execute: async (h): Promise<0> => {
        const channel = pop32(h.thread);
        if (channel >>> 0 >= 128) return fatal(h, sound, channel);
        await channels.withEngineControl((actor) => channels.stopStatic(channel, actor), h.actor);
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x26,
      nativeAddress: 0x1400e53a0,
      name: 'FadeStaticEnvelopeOut',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (channel >>> 0 >= 128) return fatal(h, sound, channel);
        await channels.withEngineControl(
          (actor) => channels.fadeEnvelope(false, channel, 0, value, actor),
          h.actor,
        );
        return 0;
      },
    },
    {
      primary: 0xa0,
      secondary: 0x2c,
      nativeAddress: 0x1400e5140,
      name: 'SetStaticAdditionalVolume',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread);
        const channel = pop32(h.thread);
        if (value >>> 0 > 128) return fatal(h, volume, value);
        if (channel >>> 0 >= 128) return fatal(h, sound, channel);
        await channels.withEngineControl(
          (actor) => channels.setAdditional(false, channel, value, actor),
          h.actor,
        );
        return 0;
      },
    },
  ];
}
