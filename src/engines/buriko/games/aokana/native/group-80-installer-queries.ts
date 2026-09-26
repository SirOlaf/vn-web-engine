import {pop32, push32} from '../bp/state.js';
import type {AokanaInstallerQueries} from './installer-queries.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

export function createGroup80InstallerQueries(
  service: AokanaInstallerQueries,
): AokanaNativeSlotDefinition[] {
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  return [
    {
      primary: 0x80,
      secondary: 0xf8,
      nativeAddress: 0x1400e6080,
      name: 'ReadInstalledFolder',
      execute: async (h): Promise<0> => {
        const product = pointer(h),
          publisher = pointer(h),
          output = pointer(h);
        push32(h.thread, await service.installedFolder(output, publisher, product));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xf9,
      nativeAddress: 0x1400e6030,
      name: 'DeleteInstallationKey',
      execute: async (h): Promise<0> => {
        const product = pointer(h),
          publisher = pointer(h);
        push32(h.thread, await service.deleteInstallation(publisher, product));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xfa,
      nativeAddress: 0x1400e5fe0,
      name: 'ReadLegacyInstalledFolder',
      execute: async (h): Promise<0> => {
        const filename = pointer(h),
          output = pointer(h);
        push32(h.thread, await service.legacyFolder(output, filename));
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xfb,
      nativeAddress: 0x1400e5fc0,
      name: 'CopyWindowsFolder',
      execute: async (h): Promise<0> => {
        await service.folders.query(pointer(h), 0);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xfe,
      nativeAddress: 0x1400e60e0,
      name: 'ReadInstallerCapability',
      execute: (h) => {
        push32(h.thread, 1);
        return 0;
      },
    },
  ];
}
