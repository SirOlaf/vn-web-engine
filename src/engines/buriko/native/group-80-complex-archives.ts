import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramArchives} from './program-archives.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {resolveBurikoAddressArray} from './vm-address-array.js';

/** E9200/BB110 installs a DCArchiveComplex into the existing shared linked archive cache. */
export function createGroup80ComplexArchives(
  archives: BurikoProgramArchives,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x38,
      nativeAddress: 0x1400e9200,
      name: 'RegisterComplexArchive',
      execute: async ({thread, memory}): Promise<0> => {
        const addresses = memory.resolve(thread, pop32(thread)),
          logical = memory.resolve(thread, pop32(thread));
        if (addresses === null)
          throw new RangeError('Buriko complex archive consumed a null address array');
        const input = pointerView(addresses);
        let count = 0;
        while (input.getUint32(count * 4, true) !== 0) count++;
        // Resolve the entire raw DWORD array first, including its terminating null. String reads
        // remain lazy in the initializer, which stops at the first resolved null pointer.
        const components = resolveBurikoAddressArray(memory, thread, addresses, count + 1);
        push32(thread, await archives.registerComplex(logical, components));
        return 0;
      },
    },
  ];
}
