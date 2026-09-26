import {pointerView} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {BurikoDisplayManager} from './display-manager.js';
import type {BurikoEngineErrors} from './engine-errors.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroup90BackdropDifference(
  manager: BurikoDisplayManager,
  errors: BurikoEngineErrors,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x90,
      secondary: 0x44,
      nativeAddress: 0x1400db3c0,
      name: 'ConfigureDifferenceBackdrop',
      execute: (context) => {
        const selection = pop32(context.thread),
          address = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread) | 0;
        const read = (index: number): number => {
          if (address === null)
            throw new RangeError('Buriko difference backdrop reads a null surface array');
          return pointerView(
            {bytes: address.bytes, offset: address.offset + index * 4},
            4,
          ).getUint32(0, true);
        };
        const surfaces: number[] = [];
        for (let index = 0; index < Math.min(count, 32); index++) surfaces.push(read(index));
        const result = manager.configureDifferenceBackdrop(count, surfaces, selection);
        let message: string;
        if (result === 1) message = `無効なビットマップ数 [ ${count} ] が指定されました`;
        else if (result === 2) {
          const values: number[] = [];
          for (let index = 0; index < count; index++) values.push(read(index) | 0);
          message = `指定されたビットマップ [ ${values.join(' , ')} ] の中に無効もしくは背景として表示できないものが含まれています`;
        } else return 0;
        return errors.threadFatal(
          context.thread,
          context.diagnostics,
          errors.files.text.encodeWide(message, 0),
        );
      },
    },
  ];
}
