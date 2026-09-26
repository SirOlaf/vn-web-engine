import {pop32, push32} from '../bp/state.js';
import {AokanaPooledAllocationDiagnostics} from './diagnostic-records.js';
import {AokanaEngineErrors} from './engine-errors.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Native critical section 3 surrounds these synchronous shared-pool mutations and logging.
 * The generic allocator remains unaware of thread/module attribution. */
export function createGroup80Allocation(
  allocations: AokanaPooledAllocationDiagnostics,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0x20,
      nativeAddress: 0x1400e9ba0,
      name: 'AllocatePooledBytes',
      execute: (h) => {
        const size = pop32(h.thread);
        if ((size - 1) >>> 0 >= 0x10000000)
          return errors.threadFatal(
            h.thread,
            h.diagnostics,
            errors.files.text.encodeWide(
              `無効なサイズ [ ${size | 0} ] byteのメモリ領域を確保しようとしました\nメモリサイズは最大で [ 268435456 ] byteまでしか確保できません`,
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
        allocations.record(address, size, h.thread);
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
        if (address !== 0 && !h.memory.freePooled(address))
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
