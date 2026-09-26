import type {BurikoBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {BurikoProgramResources} from './program-resources.js';
import type {BurikoSpecialFolders} from './special-folders.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

function popPointer(context: BurikoBpOpcodeContext): BurikoBpPointer | null {
  return context.memory.resolve(context.thread, pop32(context.thread));
}
function name(pointer: BurikoBpPointer | null): Uint8Array {
  if (pointer === null) throw new Error('Buriko resource service dereferences a null name');
  return textBytes(pointer).slice();
}

/** Resource state remains owned by ProgramResources; shell queries use the same E0 folder owner. */
export function createGroup80ResourceSettings(
  resources: BurikoProgramResources,
  folders: BurikoSpecialFolders,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x35,
      nativeAddress: 0x1400e9300,
      name: 'ReadDecodedResourceSize',
      execute: async (context): Promise<0> => {
        const filename = popPointer(context),
          archive = popPointer(context);
        const size = await resources.size(
          archive === null ? null : () => name(archive),
          name(filename),
        );
        push32(context.thread, size);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x36,
      nativeAddress: 0x1400e92e0,
      name: 'SetResourceDirectorySearch',
      execute: (context) => {
        resources.configuration.searchDirectoriesEnabled = pop32(context.thread);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x37,
      nativeAddress: 0x1400e92c0,
      name: 'PrependResourceDirectory',
      execute: (context) => {
        resources.configuration.searchDirectories.unshift(name(popPointer(context)));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x3a,
      nativeAddress: 0x1400e9180,
      name: 'CopySpecialFolder',
      execute: async (context): Promise<0> => {
        const selector = pop32(context.thread),
          output = popPointer(context);
        push32(context.thread, await folders.query(output, selector));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x3d,
      nativeAddress: 0x1400e9030,
      name: 'CopyResourceRoot',
      execute: (context) => {
        const selector = pop32(context.thread),
          output = popPointer(context);
        push32(context.thread, folders.resourceRoot(output, selector));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x3e,
      nativeAddress: 0x1400e8f80,
      name: 'SetPrimaryResourceRoot',
      execute: async (context): Promise<0> => {
        const path = popPointer(context);
        if (path === null) throw new RangeError('Buriko primary root consumed a null path');
        push32(context.thread, await resources.setPrimaryRoot(path));
        return 0;
      },
    },
  ];
}
