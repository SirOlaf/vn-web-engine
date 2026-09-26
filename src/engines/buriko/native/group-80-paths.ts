import {pop32, push32} from '../bp/state.js';
import type {BurikoPathFileDirectory} from './path-file-directory.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup80Paths(paths: BurikoPathFileDirectory): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x28,
      nativeAddress: 0x1400e9880,
      name: 'CreateDirectory',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await paths.createDirectory(path));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x29,
      nativeAddress: 0x1400e9820,
      name: 'RemoveDirectory',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await paths.removeDirectory(path));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x2a,
      nativeAddress: 0x1400e97b0,
      name: 'IsDirectory',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await paths.isDirectory(path));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x2b,
      nativeAddress: 0x1400e9710,
      name: 'SplitPath',
      execute: (h): 0 => {
        const path = h.memory.resolve(h.thread, pop32(h.thread)),
          extension = h.memory.resolve(h.thread, pop32(h.thread)),
          filename = h.memory.resolve(h.thread, pop32(h.thread)),
          directory = h.memory.resolve(h.thread, pop32(h.thread)),
          drive = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, paths.splitPath(drive, directory, filename, extension, path));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x2c,
      nativeAddress: 0x1400e96b0,
      name: 'GetFileAttributes',
      execute: async (h): Promise<0> => {
        const path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await paths.getAttributes(path));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x2d,
      nativeAddress: 0x1400e9640,
      name: 'SetFileAttributes',
      execute: async (h): Promise<0> => {
        const attributes = pop32(h.thread),
          path = h.memory.resolve(h.thread, pop32(h.thread));
        push32(h.thread, await paths.setAttributes(path, attributes));
        return 0;
      },
    },
  ];
}
