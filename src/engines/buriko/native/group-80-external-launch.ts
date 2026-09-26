import {pop32, push32} from '../bp/state.js';
import type {BurikoExternalProcesses} from './external-process.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** E6A90 fixes C71F0's show, wait, retry and ANSI mutex policy. */
export function createGroup80ExternalLaunch(
  processes: BurikoExternalProcesses,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xe0,
      nativeAddress: 0x1400e6c60,
      name: 'RunExternalCommand',
      execute: async (h): Promise<0> => {
        const toggleMainWindow = pop32(h.thread),
          failurePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          commandPointer = h.memory.resolve(h.thread, pop32(h.thread)),
          basePointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (commandPointer === null)
          throw new Error('Buriko external-command service dereferences a null command');
        const failureMessage =
            failurePointer === null ? null : textBytes(failurePointer, true).slice(),
          command = textBytes(commandPointer, true).slice(),
          baseDirectory = basePointer === null ? null : textBytes(basePointer, true).slice();
        push32(
          h.thread,
          await processes.run({
            exitCodeOutput: null,
            baseDirectory,
            command,
            currentDirectory: null,
            childShow: 1,
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
    {
      primary: 0x80,
      secondary: 0xe2,
      nativeAddress: 0x1400e6a90,
      name: 'RunExternalInstaller',
      execute: async (h): Promise<0> => {
        const failurePointer = h.memory.resolve(h.thread, pop32(h.thread)),
          commandPointer = h.memory.resolve(h.thread, pop32(h.thread)),
          basePointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (commandPointer === null)
          throw new Error('Buriko external-installer service dereferences a null command');
        const failureMessage =
            failurePointer === null ? null : textBytes(failurePointer, true).slice(),
          command = textBytes(commandPointer, true).slice(),
          baseDirectory = basePointer === null ? null : textBytes(basePointer, true).slice();
        push32(
          h.thread,
          await processes.run({
            exitCodeOutput: null,
            baseDirectory,
            command,
            currentDirectory: null,
            childShow: 1,
            failureMessage,
            toggleMainWindow: 1,
            waitForCompletion: 1,
            retryOnFailure: 0,
            waitForGlobalMutex: 1,
          }),
        );
        return 0;
      },
    },
  ];
}

/** E6A60 copies the caller string before C7150 may await shell-token discovery. */
export function createGroup80ShellExecute(
  processes: BurikoExternalProcesses,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xe3,
      nativeAddress: 0x1400e6a60,
      name: 'OpenExternalFile',
      execute: async (h): Promise<0> => {
        const pointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (pointer === null)
          throw new Error('Buriko ShellExecute service dereferences a null path');
        push32(h.thread, await processes.openShellPath(textBytes(pointer, true).slice()));
        return 0;
      },
    },
  ];
}
