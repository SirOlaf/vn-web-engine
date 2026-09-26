import {pop32, push32} from '../bp/state.js';
import type {BurikoLogicalSpatialManagers} from './logical-spatial.js';
import {BurikoLogicalSpatialDensity} from './logical-spatial-density.js';
import {burikoLogicalStatus} from './logical-status.js';
import type {BurikoNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialDensity(
  managers: BurikoLogicalSpatialManagers,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0xd0,
      secondary: 0x7b,
      nativeAddress: 0x1400d2750,
      name: 'QueryLogicalSpaceDensityMaximum',
      execute: (h) => {
        const mask = pop32(h.thread),
          exclude = pop32(h.thread),
          axis = pop32(h.thread),
          subdivisions = pop32(h.thread);
        pop32(h.thread); // Consumed and discarded by the native wrapper.
        const height = pop32(h.thread),
          width = pop32(h.thread),
          cellSize = pop32(h.thread);
        pop32(h.thread);
        pop32(h.thread);
        pop32(h.thread);
        const id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) =>
              new BurikoLogicalSpatialDensity(manager).query(
                output,
                cellSize,
                width,
                height,
                subdivisions,
                axis,
                exclude,
                mask,
              ),
            ),
          ),
        );
        return 0;
      },
    },
  ];
}
