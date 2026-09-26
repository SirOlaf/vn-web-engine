import {pop32, push32} from '../bp/state.js';
import type {BurikoBitmapCacheServices} from './bitmap-cache-services.js';
import {burikoBitmapMessage} from './bitmap-load-process.js';
import {textBytes} from './text.js';
import type {BurikoBpOpcodeContext, BurikoNativeSlotDefinition} from './types.js';

export function createGroup90BitmapCacheServices(
  service: BurikoBitmapCacheServices,
): BurikoNativeSlotDefinition[] {
  const resources = service.loading.resources.resources,
    text = resources.files.text,
    pointer = (h: BurikoBpOpcodeContext) => h.memory.resolve(h.thread, pop32(h.thread)),
    invalid = (h: BurikoBpOpcodeContext, index: number) =>
      resources.errors.threadFatal(
        h.thread,
        h.diagnostics,
        text.encodeWide(`無効なビットマップ番号 [ ${index | 0} ] が指定されました`, 0),
      );
  return [
    {
      primary: 0x90,
      secondary: 0xc0,
      nativeAddress: 0x1400d7a10,
      name: 'AllocateResourceHeaderBitmap',
      execute: async (h): Promise<0> => {
        const namePointer = pointer(h),
          archivePointer = pointer(h),
          index = pop32(h.thread);
        if (index >>> 0 >= 0x4000) return invalid(h, index);
        const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
        if (namePointer === null) throw new Error('Buriko header resource consumes null name');
        const name = textBytes(namePointer).slice(),
          result = await service.allocateHeader(index, archive, name);
        if (result === 0x8000000d || result === 0xffffffff) {
          const message = burikoBitmapMessage(
            text,
            result === 0x8000000d
              ? '指定されたファイル [ %s : %s ] はBG形式ではありません'
              : '指定されたファイル [ %s : %s ] は存在しません',
            [archive ?? new TextEncoder().encode('(null)'), name],
          );
          if (message.length > 256)
            throw new RangeError('Buriko header bitmap diagnostic exceeds native scratch');
          return resources.errors.threadFatal(h.thread, h.diagnostics, message);
        }
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xc1,
      nativeAddress: 0x1400d79b0,
      name: 'CheckBitmapGroupResources',
      execute: async (h): Promise<0> => {
        const description = pointer(h),
          archive = pointer(h),
          output = pointer(h);
        push32(h.thread, await service.groupAvailable(output, archive, description));
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xc6,
      nativeAddress: 0x1400d75d0,
      name: 'RegisterPreloadedBitmap',
      execute: (h) => {
        const count = pop32(h.thread),
          source = pointer(h),
          name = pointer(h),
          archive = pointer(h);
        push32(
          h.thread,
          Number(service.registration.preloadPointers(archive, name, source, count) === 0),
        );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0xc7,
      nativeAddress: 0x1400d7540,
      name: 'ImportCachedBitmap',
      execute: (h) => {
        const consume = pop32(h.thread),
          namePointer = pointer(h),
          archivePointer = pointer(h),
          index = pop32(h.thread);
        if (index >>> 0 >= 0x4000) return invalid(h, index);
        const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
        if (namePointer === null) throw new Error('Buriko cached bitmap lookup consumes null name');
        push32(
          h.thread,
          Number(
            service.loading.fromCache(index, archive, textBytes(namePointer).slice(), consume) ===
              0,
          ),
        );
        return 0;
      },
    },
  ];
}
