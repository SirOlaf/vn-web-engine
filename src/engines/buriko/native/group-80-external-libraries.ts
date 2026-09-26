import {pop32, push32} from '../bp/state.js';
import type {WindowsDynamicArgument} from '../../../platform/windows-dynamic-library.js';
import type {BurikoExternalLibraries} from './external-libraries.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

function signed32(value: number): bigint {
  return BigInt.asIntN(32, BigInt(value));
}

/** E6930/E6900/E6830 are the B7990/B7920/B78C0 linked-library registry. */
export function createGroup80ExternalLibraries(
  libraries: BurikoExternalLibraries,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xec,
      nativeAddress: 0x1400e6930,
      name: 'LoadExternalLibrary',
      execute: (h) => {
        const name = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        if (name === null) throw new Error('Buriko DLL load dereferences a null name');
        push32(h.thread, libraries.load(textBytes(name, true).slice(), output));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xed,
      nativeAddress: 0x1400e6900,
      name: 'UnloadExternalLibrary',
      execute: (h) => {
        push32(h.thread, libraries.unload(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xee,
      nativeAddress: 0x1400e6830,
      name: 'CallExternalLibrary',
      execute: (h) => {
        const flags = pop32(h.thread);
        const argument = (pointer: boolean): WindowsDynamicArgument =>
          pointer
            ? {kind: 'memory', pointer: h.memory.resolve(h.thread, pop32(h.thread))}
            : {kind: 'signed', value: signed32(pop32(h.thread))};
        const third = argument((flags & 0xffff0000) !== 0),
          second = argument((flags & 0xffff) !== 0),
          first = signed32(pop32(h.thread)),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, libraries.call(id, first, second, third, output));
        return 0;
      },
    },
  ];
}
