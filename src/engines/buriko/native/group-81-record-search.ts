import {pop32, push32} from '../bp/state.js';
import {findBurikoMatchingRecord, writeBurikoMatchingRecordIndices} from './record-search.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Native wrappers initialize exactly one scalar DWORD, with no invented upper bytes for width8. */
function scalar(value: number): {bytes: Uint8Array; offset: number} {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return {bytes, offset: 0};
}

export function createGroup81RecordSearch(): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xb8,
      nativeAddress: 0x1400eada0,
      name: 'FindMatchingRecord',
      execute: (h) => {
        const options = pop32(h.thread),
          format = pop32(h.thread),
          comparisonValue = pop32(h.thread),
          stride = pop32(h.thread),
          count = pop32(h.thread),
          source = h.memory.resolve(h.thread, pop32(h.thread)),
          comparison =
            (format & 0xffff) === 0xffff
              ? h.memory.resolve(h.thread, comparisonValue)
              : scalar(comparisonValue);
        push32(
          h.thread,
          findBurikoMatchingRecord(source, count, stride, comparison, format, options),
        );
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0xb9,
      nativeAddress: 0x1400eacd0,
      name: 'WriteMatchingRecordIndices',
      execute: (h) => {
        const options = pop32(h.thread),
          format = pop32(h.thread),
          comparisonValue = pop32(h.thread),
          stride = pop32(h.thread),
          count = pop32(h.thread),
          source = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          comparison =
            (format & 0xffff) === 0xffff
              ? h.memory.resolve(h.thread, comparisonValue)
              : scalar(comparisonValue);
        push32(
          h.thread,
          writeBurikoMatchingRecordIndices(
            output,
            source,
            count,
            stride,
            comparison,
            format,
            options,
          ),
        );
        return 0;
      },
    },
  ];
}
