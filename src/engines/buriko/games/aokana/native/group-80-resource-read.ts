import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {AokanaProgramResources} from './program-resources.js';
import type {AokanaResourceDestination} from './resource-decode.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';
function required(pointer: AokanaBpPointer | null): AokanaBpPointer {
  if (pointer === null) throw new RangeError('Aokana resource read consumed a null filename');
  return pointer;
}
function output(pointer: AokanaBpPointer | null): AokanaResourceDestination | null {
  if (pointer === null) return null;
  const view = pointerView(pointer);
  return {bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength)};
}
/** E9520/E9490 pass the resolved output pointer through the real resource decoder. */
export function createGroup80ResourceRead(
  resources: AokanaProgramResources,
): AokanaNativeSlotDefinition[] {
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
          textBytes(required(name)),
          true,
          output(destination),
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
          archive === null ? null : () => textBytes(archive),
          textBytes(required(name)),
          offset,
          length,
          output(destination),
        );
        push32(h.thread, result.result);
        return 0;
      },
    },
  ];
}
