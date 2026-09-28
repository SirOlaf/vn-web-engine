import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramResources} from './program-resources.js';
import {borrowedPointer, type BurikoResourceDestination} from './resource-decode.js';
import {scanText, textBytes, textReader} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';
function required(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null) throw new RangeError('Buriko resource read consumed a null filename');
  return pointer;
}
function output(pointer: BurikoBpPointer | null): BurikoResourceDestination | null {
  if (pointer === null) return null;
  pointerView(pointer);
  return borrowedPointer(pointer);
}
/** E9520/E9490 pass the resolved output pointer through the real resource decoder. */
export function createGroup80ResourceRead(
  resources: BurikoProgramResources,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x30,
      nativeAddress: 0x1400e9520,
      name: 'ReadResource',
      execute: async (h): Promise<0> => {
        const name = h.memory.resolve(h.thread, pop32(h.thread)),
          archive = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        const result = await resources.load(
          archive === null ? null : () => textBytes(archive),
          scanText(required(name)),
          true,
          output(destination),
          h.actor,
        );
        push32(h.thread, result.result);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x31,
      nativeAddress: 0x1400e9490,
      name: 'ReadPartialResource',
      execute: async (h): Promise<0> => {
        const length = pop32(h.thread),
          offset = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread)),
          archive = h.memory.resolve(h.thread, pop32(h.thread)),
          destination = h.memory.resolve(h.thread, pop32(h.thread));
        const result = await resources.loadPartial(
          archive === null ? null : textReader(archive),
          scanText(required(name)),
          offset,
          length,
          output(destination),
          h.actor,
        );
        push32(h.thread, result.result);
        return 0;
      },
    },
  ];
}
