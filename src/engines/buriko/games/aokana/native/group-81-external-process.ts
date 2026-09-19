import {pop32, push32} from '../bp/state.js';
import type {AokanaExternalProcesses} from './external-process.js';
import {textBytes} from './text.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** 81 E0 copies every input needed by the blocking host while retaining the live exit output. */
export function createGroup81ExternalProcess(
  processes: AokanaExternalProcesses,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x81,
      secondary: 0xe0,
      nativeAddress: 0x1400ea8e0,
      name: 'RunExternalProcess',
      execute: async (h): Promise<0> => {
        const toggleMainWindow = pop32(h.thread),
          failurePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          childShow = pop32(h.thread),
          currentPointer = h.memory.resolve(h.thread, pop32(h.thread)),
          commandPointer = h.memory.resolve(h.thread, pop32(h.thread)),
          basePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          exitCodeOutput = h.memory.resolve(h.thread, pop32(h.thread));
        if (commandPointer === null)
          throw new Error('Aokana external-process service dereferences a null command');
        const failureMessage =
            failurePointer === null ? null : textBytes(failurePointer, true).slice(),
          currentDirectory =
            currentPointer === null ? null : textBytes(currentPointer, true).slice(),
          command = textBytes(commandPointer, true).slice(),
          baseDirectory = basePointer === null ? null : textBytes(basePointer, true).slice();
        push32(
          h.thread,
          await processes.run({
            exitCodeOutput,
            baseDirectory,
            command,
            currentDirectory,
            childShow,
            failureMessage,
            toggleMainWindow,
            waitForCompletion: 1,
            retryOnFailure: 1,
            waitForGlobalMutex: 0,
          }),
        );
        return 0;
      },
    },
  ];
}
