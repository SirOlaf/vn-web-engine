import {pop32, push32} from '../bp/state.js';
import type {AokanaDiskImageService} from './disk-image-service.js';
import type {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** D7720/D7650: GDI+ disk image wrappers over a selected real codec host. */
export function createGroup90DiskImages(
  service: AokanaDiskImageService,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const pointer = (h: AokanaBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread));
  const invalid = (h: AokanaBpOpcodeContext, index: number): Promise<never> =>
    errors.threadFatal(
      h.thread,
      h.diagnostics,
      service.text.encodeWide(`無効なビットマップ番号 [ ${index | 0} ] が指定されました`, 0),
    );
  return [
    {
      primary: 0x90,
      secondary: 0xc4,
      nativeAddress: 0x1400d7720,
      name: 'ImportDiskImage',
      execute: async (h): Promise<0> => {
        const mode = pop32(h.thread),
          filename = pointer(h),
          index = pop32(h.thread);
        if (index >>> 0 >= 0x4000) return invalid(h, index);
        if (filename === null) throw new Error('Aokana GDI+ import consumes a null filename');
        const result = await service.import(index, filename, mode);
        push32(
          h.thread,
          result === 0 ? 0 : result === 0x80000001 ? 1 : result === 0x80000002 ? 2 : 0xffffffff,
        );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xc5,
      nativeAddress: 0x1400d7650,
      name: 'ExportDiskImage',
      execute: async (h): Promise<0> => {
        const index = pop32(h.thread),
          quality = pop32(h.thread),
          format = pop32(h.thread),
          filename = pointer(h);
        if (index >>> 0 >= 0x4000) return invalid(h, index);
        if (filename === null) throw new Error('Aokana GDI+ export consumes a null filename');
        const result = await service.export(filename, format, quality, index);
        push32(
          h.thread,
          result === 0
            ? 0
            : result === 0x80000003
              ? 3
              : result === 0x80000004
                ? 4
                : result === 0x80000005
                  ? 5
                  : 0xffffffff,
        );
        return 0;
      },
    },
  ];
}
