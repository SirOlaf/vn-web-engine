import {pop32, push32} from '../bp/state.js';
import {burikoFixedToFloat} from './logical-spatial.js';
import type {BurikoLogicalSpatialManagers} from './logical-spatial.js';
import {BurikoLogicalSpatialQueries} from './logical-spatial-queries.js';
import {burikoLogicalStatus} from './logical-status.js';
import type {BurikoBpOpcodeHandler, BurikoNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialQueries(
  managers: BurikoLogicalSpatialManagers,
): BurikoNativeSlotDefinition[] {
  const definitions: [number, number, string, BurikoBpOpcodeHandler][] = [
    ...(
      [
        [0x74, 0x1400d2b40, 'QueryLogicalSpaceOffsetOverlaps'],
        [0x78, 0x1400d2990, 'QueryLogicalSpaceNeighbors'],
      ] as const
    ).map(([secondary, address, name]): [number, number, string, BurikoBpOpcodeHandler] => [
      secondary,
      address,
      name,
      (h) => {
        const mask = pop32(h.thread),
          sourceIndex = pop32(h.thread),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => {
              const queries = new BurikoLogicalSpatialQueries(manager);
              return secondary === 0x74
                ? queries.overlapsAtRecord(output, count, sourceIndex, mask)
                : queries.neighbors(output, count, sourceIndex, mask);
            }),
          ),
        );
        return 0;
      },
    ]),
    [
      0x75,
      0x1400d2a20,
      'QueryLogicalSpaceSphereOverlaps',
      (h) => {
        const mask = pop32(h.thread),
          exclude = pop32(h.thread),
          radius = burikoFixedToFloat(pop32(h.thread)),
          z = burikoFixedToFloat(pop32(h.thread)),
          y = burikoFixedToFloat(pop32(h.thread)),
          x = burikoFixedToFloat(pop32(h.thread)),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) =>
              new BurikoLogicalSpatialQueries(manager).overlaps(
                output,
                count,
                [x, y, z, 0],
                radius,
                exclude,
                mask,
              ),
            ),
          ),
        );
        return 0;
      },
    ],
    [
      0x79,
      0x1400d2910,
      'QueryLogicalSpaceRelativeRecord',
      (h) => {
        const target = pop32(h.thread),
          source = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) =>
              new BurikoLogicalSpatialQueries(manager).relativeToRecord(output, source, target),
            ),
          ),
        );
        return 0;
      },
    ],
    [
      0x7a,
      0x1400d2850,
      'QueryLogicalSpaceRelativePosition',
      (h) => {
        const z = burikoFixedToFloat(pop32(h.thread)),
          y = burikoFixedToFloat(pop32(h.thread)),
          x = burikoFixedToFloat(pop32(h.thread)),
          source = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) =>
              new BurikoLogicalSpatialQueries(manager).relativeToPosition(output, source, x, y, z),
            ),
          ),
        );
        return 0;
      },
    ],
  ];
  return definitions.map(([secondary, nativeAddress, name, execute]) => ({
    primary: 0xd0,
    secondary,
    nativeAddress,
    name,
    execute,
  }));
}
