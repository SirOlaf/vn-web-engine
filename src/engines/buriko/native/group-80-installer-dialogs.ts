import {pop32, push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoInstallerDialogs} from './installer-dialogs.js';
import {textBytes} from './text.js';
import type {BurikoNativeSlotDefinition} from './types.js';

const snapshot = (pointer: BurikoBpPointer | null): Uint8Array | null =>
  pointer === null ? null : textBytes(pointer, true).slice();

export function createGroup80InstallerDialogs(
  owner: BurikoInstallerDialogs,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xf0,
      nativeAddress: 0x1400e6760,
      name: 'ChooseInstallerDestination',
      execute: async ({thread, memory}): Promise<0> => {
        const description = snapshot(memory.resolve(thread, pop32(thread))),
          rootSuffix = snapshot(memory.resolve(thread, pop32(thread))),
          initialA = pop32(thread),
          initialB = pop32(thread),
          initialPath = snapshot(memory.resolve(thread, pop32(thread))),
          outputB = memory.resolve(thread, pop32(thread)),
          outputA = memory.resolve(thread, pop32(thread)),
          outputPath = memory.resolve(thread, pop32(thread));
        if (initialPath === null)
          throw new Error('Buriko installer dialog dereferences a null initial path');
        push32(
          thread,
          await owner.chooseDestination(
            outputPath,
            outputA,
            outputB,
            initialPath,
            initialB,
            initialA,
            rootSuffix,
            description,
          ),
        );
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xf1,
      nativeAddress: 0x1400e66c0,
      name: 'ChooseInstallerComponent',
      execute: async ({thread, memory}): Promise<0> => {
        const disabledChoice = pop32(thread),
          showSpecial = pop32(thread),
          third = snapshot(memory.resolve(thread, pop32(thread))),
          second = snapshot(memory.resolve(thread, pop32(thread))),
          first = snapshot(memory.resolve(thread, pop32(thread))),
          description = snapshot(memory.resolve(thread, pop32(thread)));
        if (description === null || second === null || third === null)
          throw new Error('Buriko installer component dialog dereferences a null label');
        push32(
          thread,
          await owner.chooseComponent(
            description,
            first,
            second,
            third,
            showSpecial,
            disabledChoice,
          ),
        );
        return 0;
      },
    },
  ];
}
