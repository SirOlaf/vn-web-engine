import {pop32, push32} from '../bp/state.js';
import type {AokanaScriptFiles} from './script-files.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroup81Files(files: AokanaScriptFiles): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0x28,
      nativeAddress: 0x1400ec070,
      name: 'OpenScriptFile',
      execute: async (h): Promise<0> => {
        const mode = pop32(h.thread),
          path = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        const result = await files.open(output, path, mode);
        push32(
          h.thread,
          result >= 0x80000001 && result <= 0x80000003 ? result - 0x80000000 : result,
        );
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x29,
      nativeAddress: 0x1400ec010,
      name: 'QueueFileClose',
      execute: async (h): Promise<0> => {
        const id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          result = await files.queueClose(output, id);
        push32(h.thread, result === 0x80000004 ? 4 : result);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x2a,
      nativeAddress: 0x1400ebf80,
      name: 'QueueFileTransfer',
      execute: async (h): Promise<0> => {
        const count = pop32(h.thread),
          buffer = h.memory.resolve(h.thread, pop32(h.thread)),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          result = await files.queueTransfer(output, id, buffer, count);
        push32(h.thread, result === 0x80000004 ? 4 : result);
        return 0;
      },
    },
    {
      primary: 0x81,
      secondary: 0x2b,
      nativeAddress: 0x1400ebf10,
      name: 'QueueFileSeek',
      execute: async (h): Promise<0> => {
        const position = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread)),
          result = await files.queueSeek(output, id, position);
        push32(h.thread, result === 0x80000004 ? 4 : result);
        return 0;
      },
    },
  ];
}
