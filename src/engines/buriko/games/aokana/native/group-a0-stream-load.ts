import {pop32} from '../bp/state.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';
import {
  AokanaAudioMusicResources,
  aokanaMissingWaveDiagnostic,
  aokanaInvalidWaveDiagnostic,
  formatAokanaAudioNames,
} from './audio/resource-music.js';

const music = [
  150, 179, 140, 248, 130, 200, 137, 185, 138, 121, 131, 96, 131, 131, 131, 147, 131, 108, 131, 139,
  148, 212, 141, 134,
];
const volume = [
  150, 179, 140, 248, 130, 200, 131, 123, 131, 138, 131, 133, 129, 91, 131, 128, 129, 105, 137, 185,
  151, 202, 129, 106,
];
const suffix = [130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0];

/** E5D00: synchronous one-name music admission; A0:11 has its own process owner. */
export function createGroupA0StreamLoad(
  musicResources: AokanaAudioMusicResources,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0x10,
      nativeAddress: 0x1400e5d00,
      name: 'LoadStreamResource',
      execute: async (h): Promise<0> => {
        const value = pop32(h.thread),
          pointer = h.memory.resolve(h.thread, pop32(h.thread)),
          channel = pop32(h.thread);
        const fatal = (prefix: number[], argument: number) =>
          errors.threadFatal(
            h.thread,
            h.diagnostics,
            Uint8Array.from([
              ...prefix,
              ...new TextEncoder().encode(` [ ${argument | 0} ] `),
              ...suffix,
            ]),
          );
        if (value >>> 0 > 128) return fatal(volume, value);
        if (channel >>> 0 >= 16) return fatal(music, channel);
        const name = () => {
          if (pointer === null) throw new Error('Aokana music name consumes a null native pointer');
          return textBytes(pointer, true);
        };
        const status = await musicResources.loadSimple(channel, name, value, h.actor);
        if (status === 12 || status === 14)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            formatAokanaAudioNames(
              status === 12 ? aokanaMissingWaveDiagnostic : aokanaInvalidWaveDiagnostic,
              [name()],
              256,
            ),
          );
        return 0;
      },
    },
  ];
}
