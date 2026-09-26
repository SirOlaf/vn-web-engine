import {pop32, push32} from '../bp/state.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import {aokanaLogicalStatus} from './logical-status.js';
import {aokanaFixedToFloat} from './logical-spatial.js';
import type {AokanaLogicalSpatialManager, AokanaLogicalSpatialManagers} from './logical-spatial.js';
import {AokanaLogicalSpatialSearch} from './logical-spatial-search.js';
import type {AokanaNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialSearch(
  managers: AokanaLogicalSpatialManagers,
  processing: AokanaDistributedProcessing,
): AokanaNativeSlotDefinition[] {
  const searches = new WeakMap<AokanaLogicalSpatialManager, AokanaLogicalSpatialSearch>();
  return [
    {
      primary: 0xd0,
      secondary: 0x72,
      nativeAddress: 0x1400d2bd0,
      name: 'SearchLogicalSpace',
      execute: (h) => {
        const distributed = pop32(h.thread),
          resolution = pop32(h.thread),
          checkSegment = pop32(h.thread),
          mask = pop32(h.thread),
          step = aokanaFixedToFloat(pop32(h.thread)),
          range = aokanaFixedToFloat(pop32(h.thread)),
          target = pop32(h.thread),
          source = pop32(h.thread),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          aokanaLogicalStatus(
            managers.use(id, (manager) => {
              let search = searches.get(manager);
              if (search === undefined) {
                search = new AokanaLogicalSpatialSearch(manager, processing);
                searches.set(manager, search);
              }
              return search.query(
                output,
                count,
                source,
                target,
                range,
                step,
                mask,
                checkSegment,
                resolution,
                distributed,
              );
            }),
          ),
        );
        return 0;
      },
    },
  ];
}
