import {pop32, push32} from '../bp/state.js';
import {BurikoPooledAllocationDiagnostics} from './diagnostic-records.js';
import {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

/** Native critical section 3 surrounds these synchronous shared-pool mutations and logging.
 * The generic allocator remains unaware of thread/module attribution. */
export function createGroup80Allocation(
  allocations: BurikoPooledAllocationDiagnostics,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x20,
      nativeAddress: 0x1400e9ba0,
      name: 'AllocatePooledBytes',
      execute: (h) => {
        const size = pop32(h.thread);
        const legacy = h.memory.abi.compatibility === '1.69';
        const limit = h.memory.abi.addressMask + 1;
        if (legacy ? size > limit : (size - 1) >>> 0 >= limit)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `無効なサイズ [ ${size | 0} ] byteのメモリ領域を確保しようとしました\nメモリサイズは最大で [ ${limit} ] byteまでしか確保できません`,
              0,
            ),
          );
        const address = h.memory.allocatePooled(size);
        if (address === 0)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide('グローバル領域に空きがありません', 0),
          );
        if (!legacy) allocations.record(address, size, h.thread);
        push32(h.thread, address);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0x21,
      nativeAddress: 0x1400e9b00,
      name: 'FreePooledBytes',
      execute: (h) => {
        const address = pop32(h.thread);
        if (
          (address !== 0 || h.memory.abi.compatibility === '1.69') &&
          !h.memory.freePooled(address)
        )
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `グローバルメモリの解放の対象に不正なアドレス [ $${(address >>> 0).toString(16).toUpperCase().padStart(8, '0')} ] が指定されました`,
              0,
            ),
          );
        allocations.remove(address);
        push32(h.thread, 1);
        return 0;
      },
    },
  ];
}
