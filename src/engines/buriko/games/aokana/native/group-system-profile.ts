import {pointerView} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaSystemProfile} from './system-profile.js';
import {copyText, writeText} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** System-query wrappers preserve the native pop/query/write sequence and shared OS cache. */
export function createGroupSystemProfile(
  profile: AokanaSystemProfile,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x0d,
      nativeAddress: 0x1400ea070,
      name: 'ReadLegacyPhysicalMemory',
      execute: (h) => {
        const [total, available] = profile.readLegacyMemory();
        push32(h.thread, total);
        push32(h.thread, available);
        return 0;
      },
    },
    ...(
      [
        [0x08, 0x1400ec710, 'ReadUserName', () => profile.userName()],
        [0x09, 0x1400ec6e0, 'ReadComputerName', () => profile.computerName()],
      ] as const
    ).map(([secondary, nativeAddress, name, read]): AokanaNativeSlotDefinition => ({
      primary: 0x81,
      secondary,
      nativeAddress,
      name,
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        const bytes = read();
        // The Win32 name API reports failure for a null output buffer; the wrapper ignores it.
        if (destination !== null && bytes !== null) writeText(destination, bytes);
        return 0;
      },
    })),
    {
      primary: 0x81,
      secondary: 0x0c,
      nativeAddress: 0x1400ec5f0,
      name: 'ReadWindowsVersion',
      execute: (h) => {
        const servicePack = h.memory.resolve(h.thread, pop32(h.thread)),
          numbers = h.memory.resolve(h.thread, pop32(h.thread));
        const record = profile.readVersionRecord(),
          version = new DataView(record.buffer);
        if (numbers === null) throw new Error('Aokana system version null numeric destination');
        for (let index = 0; index < 4; index++)
          pointerView({bytes: numbers.bytes, offset: numbers.offset + index * 4}, 4).setUint32(
            0,
            version.getUint32(4 + index * 4, true),
            true,
          );
        if (servicePack === null) throw new Error('Aokana system version null text destination');
        copyText(servicePack, {bytes: record, offset: 20});
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x0d,
      nativeAddress: 0x1400ec560,
      name: 'ReadPhysicalMemoryMegabytes',
      execute: (h) => {
        const available = h.memory.resolve(h.thread, pop32(h.thread)),
          total = h.memory.resolve(h.thread, pop32(h.thread));
        const values = profile.readMemoryMegabytes();
        if (total === null) throw new Error('Aokana physical memory null total destination');
        pointerView(total, 4).setUint32(0, values[0], true);
        if (available === null)
          throw new Error('Aokana physical memory null available destination');
        pointerView(available, 4).setUint32(0, values[1], true);
        return 0;
      },
    },
  ];
}
