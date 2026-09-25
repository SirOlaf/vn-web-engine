import {pop32} from '../bp/state.js';
import {formatAokanaAudioNames} from './audio/resource-music.js';
import type {AokanaAudioMusicResources} from './audio/resource-music.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

const literal = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!, (value) => parseInt(value, 16));
const pan = [
  150, 179, 140, 248, 130, 200, 131, 112, 131, 147, 131, 124, 131, 98, 131, 103, 129, 105, 146, 232,
  136, 202, 129, 106,
];
const volume = [
  150, 179, 140, 248, 130, 200, 131, 123, 131, 138, 131, 133, 129, 91, 131, 128, 129, 105, 137, 185,
  151, 202, 129, 106,
];
const musicChannel = [
  150, 179, 140, 248, 130, 200, 137, 185, 138, 121, 131, 96, 131, 131, 131, 147, 131, 108, 131, 139,
  148, 212, 141, 134,
];
const invalidSuffix = [
  130, 170, 142, 119, 146, 232, 130, 179, 130, 234, 130, 220, 130, 181, 130, 189, 0,
];
const nullName = new TextEncoder().encode('(null)\0');

/** Raw 140185E90: archive : first / second. */
export const aokanaPairMissingWaveDiagnostic = literal(
  '8e7792e882b382ea82bd4257837483408343838b205b202573203a202573202f202573205d2082cd91b68ddd82b582dc82b982f100',
);
/** Raw 140185DE0: archive : first / second. */
export const aokanaPairInvalidWaveDiagnostic = literal(
  '8e7792e882b382ea82bd837483408343838b205b202573203a202573202f202573205d2082cd4257837483408343838b82c582cd82c882a282e682a482c582b700',
);

/** E5A50: synchronous paired music, with no A0:11 process/worker branch. */
export function createGroupA0PairedMusicLoad(
  music: AokanaAudioMusicResources,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0xa0,
      secondary: 0x12,
      nativeAddress: 0x1400e5a50,
      name: 'LoadPairedMusicResource',
      execute: async (h): Promise<0> => {
        const position = pop32(h.thread),
          level = pop32(h.thread),
          rawMode = pop32(h.thread),
          last = h.memory.resolve(h.thread, pop32(h.thread)),
          first = h.memory.resolve(h.thread, pop32(h.thread)),
          archive = h.memory.resolve(h.thread, pop32(h.thread)),
          channel = pop32(h.thread);
        const invalid = (prefix: number[], value: number) =>
          errors.threadFatal(
            h.thread,
            h.diagnostics,
            Uint8Array.from([
              ...prefix,
              ...new TextEncoder().encode(` [ ${value | 0} ] `),
              ...invalidSuffix,
            ]),
          );
        if (position >>> 0 > 128) return invalid(pan, position);
        if (level >>> 0 > 128) return invalid(volume, level);
        if (channel >>> 0 >= 16) return invalid(musicChannel, channel);
        const name = (pointer: typeof first) => () => {
            if (pointer === null) throw new Error('Aokana paired music dereferences a null name');
            return textBytes(pointer, true);
          },
          archiveName = archive === null ? null : name(archive),
          firstName = name(first),
          lastName = name(last);
        const status = await music.loadPairMusic(
          channel,
          archiveName,
          firstName,
          lastName,
          rawMode,
          level,
          position,
          h.actor,
        );
        if (status === 12 || status === 14)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            formatAokanaAudioNames(
              status === 12 ? aokanaPairMissingWaveDiagnostic : aokanaPairInvalidWaveDiagnostic,
              [archiveName === null ? nullName : archiveName(), firstName(), lastName()],
              256,
            ),
          );
        return 0;
      },
    },
  ];
}
