import {pop32, push32} from '../bp/state.js';
import type {BurikoNamedBitArrays} from './named-bit-arrays.js';
import type {BurikoNativeSlotDefinition} from './types.js';

function translateNamedBitStatus(status: number, range: boolean): number {
  status >>>= 0;
  if (status === 0) return 0;
  if (status === 0x80000002) return 1;
  if (status === 0x80000003) return 2;
  if (range && status === 0x80000004) return 3;
  return status;
}

/** Bank 80:88-8B use the same named-bit owner as startup, save, and GDB restore. */
export function createGroup80NamedBitArrays(
  bits: BurikoNamedBitArrays,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x88,
      nativeAddress: 0x1400e7dd0,
      name: 'CreateNamedBitArray',
      execute: (h) => {
        const bitCount = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, Number(bits.createOrResize(name!, bitCount) === 0));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x89,
      nativeAddress: 0x1400e7d50,
      name: 'WriteNamedBit',
      execute: (h) => {
        const value = pop32(h.thread),
          bitIndex = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, translateNamedBitStatus(bits.writeBit(name, bitIndex, value), false));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x8a,
      nativeAddress: 0x1400e7ca0,
      name: 'WriteNamedBitRange',
      execute: (h) => {
        const count = pop32(h.thread),
          value = pop32(h.thread),
          start = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, translateNamedBitStatus(bits.writeRange(name, start, value, count), true));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x8b,
      nativeAddress: 0x1400e7c20,
      name: 'ReadNamedBit',
      execute: (h) => {
        const bitIndex = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, translateNamedBitStatus(bits.readBit(output, name, bitIndex), false));
        return 0;
      },
    },
  ];
}
