import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeSlotDefinition} from './types.js';
import {BurikoCrtRandom, BurikoVmFrameHistory, nativeNanoseconds} from './system-timing.js';
import type {BurikoNativePerformanceCounter} from './system-timing.js';

export function createGroup80Timing(
  random: BurikoCrtRandom,
  history: BurikoVmFrameHistory,
  clock: BurikoNativeClock,
  counter: BurikoNativePerformanceCounter,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x00,
      nativeAddress: 0x1400ea390,
      name: 'SeedCrtRandom',
      execute: (h) => {
        random.seed(pop32(h.thread));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x01,
      nativeAddress: 0x1400ea360,
      name: 'CrtRandom',
      execute: (h) => {
        push32(h.thread, random.next());
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x02,
      nativeAddress: 0x1400ea2f0,
      name: 'BoundedCrtRandom',
      execute: (h) => {
        push32(h.thread, random.bounded(pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x03,
      nativeAddress: 0x1400ea2a0,
      name: 'ReadFrameHistory',
      execute: (h) => {
        const count = pop32(h.thread),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, history.copy(destination, count));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x04,
      nativeAddress: 0x1400ea270,
      name: 'ElapsedMilliseconds',
      execute: (h) => {
        push32(h.thread, Number(BigInt.asUintN(32, clock.read())));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x05,
      nativeAddress: 0x1400ea240,
      name: 'PerformanceNanoseconds',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        const value = nativeNanoseconds(counter, clock);
        if (destination === null) throw new Error('Buriko native timer null destination');
        pointerView(destination, 8).setBigInt64(0, value, true);
        push32(h.thread, 1);
        return 0;
      },
    },
  ];
}

export function createGroup80LocalTime(readLocalTime: () => Date): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x0c,
      nativeAddress: 0x1400ea0f0,
      name: 'ReadLocalTime',
      execute: (h) => {
        const destination = h.memory.resolve(h.thread, pop32(h.thread));
        const value = readLocalTime();
        if (!Number.isFinite(value.getTime()))
          throw new Error('Buriko native local-time host returned an invalid date');
        if (destination === null) throw new Error('Buriko native local-time null destination');
        const words = [
          value.getFullYear(),
          value.getMonth() + 1,
          value.getDay(),
          value.getDate(),
          value.getHours(),
          value.getMinutes(),
          value.getSeconds(),
          value.getMilliseconds(),
        ];
        const output = pointerView(destination, 16);
        for (let index = 0; index < words.length; index++)
          output.setUint16(index * 2, words[index]!, true);
        return 0;
      },
    },
  ];
}
