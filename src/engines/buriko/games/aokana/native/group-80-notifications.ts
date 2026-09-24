import {pop32, push32} from '../bp/state.js';
import {pointerView} from '../bp/memory.js';
import {AokanaNativeNotifications} from './notification-queue.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** 80A0 is the sole native dequeue consumer of the0fa3b0 FIFO. */
export function createGroup80Notifications(
  queue: AokanaNativeNotifications,
): AokanaNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xa0,
      nativeAddress: 0x1400e75a0,
      name: 'TakeNativeNotification',
      execute: (context) => {
        const pointer = context.memory.resolve(context.thread, pop32(context.thread));
        const record = queue.take();
        if (record !== null) {
          if (pointer === null)
            throw new TypeError('Aokana native notification writes through a null output pointer');
          pointerView(pointer, 8).setBigUint64(
            0,
            BigInt(record.type) | (BigInt(record.value1) << 32n),
            true,
          );
          pointerView({bytes: pointer.bytes, offset: pointer.offset + 8}, 4).setUint32(
            0,
            record.value2,
            true,
          );
        }
        push32(context.thread, record === null ? 0 : 1);
        return 0;
      },
    },
    {
      primary: 0x80,
      secondary: 0xa1,
      nativeAddress: 0x1400e7570,
      name: 'AppendNativeNotification',
      execute: (context) => {
        const value2 = pop32(context.thread),
          value1 = pop32(context.thread);
        queue.push(0, value1, value2);
        return 0;
      },
    },
  ];
}
