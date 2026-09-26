import {pop32, push32} from '../bp/state.js';
import {aokanaFixedToFloat} from './logical-spatial.js';
import type {AokanaLogicalSpatialManagers} from './logical-spatial.js';
import {AokanaLogicalSpatialQueries} from './logical-spatial-queries.js';
import {aokanaLogicalStatus} from './logical-status.js';
import type {AokanaBpOpcodeHandler, AokanaNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialQueries(
  managers: AokanaLogicalSpatialManagers,
): AokanaNativeSlotDefinition[] {
  const definitions: [number, number, string, AokanaBpOpcodeHandler][] = [
    ...(
      [
        [0x74, 0x1400d2b40, 'QueryLogicalSpaceOffsetOverlaps'],
        [0x78, 0x1400d2990, 'QueryLogicalSpaceNeighbors'],
      ] as const
    ).map(([secondary, address, name]): [number, number, string, AokanaBpOpcodeHandler] => [
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
          aokanaLogicalStatus(
            managers.use(id, (manager) => {
              const queries = new AokanaLogicalSpatialQueries(manager);
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
          radius = aokanaFixedToFloat(pop32(h.thread)),
          z = aokanaFixedToFloat(pop32(h.thread)),
          y = aokanaFixedToFloat(pop32(h.thread)),
          x = aokanaFixedToFloat(pop32(h.thread)),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          aokanaLogicalStatus(
            managers.use(id, (manager) =>
              new AokanaLogicalSpatialQueries(manager).overlaps(
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
          aokanaLogicalStatus(
            managers.use(id, (manager) =>
              new AokanaLogicalSpatialQueries(manager).relativeToRecord(output, source, target),
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
        const z = aokanaFixedToFloat(pop32(h.thread)),
          y = aokanaFixedToFloat(pop32(h.thread)),
          x = aokanaFixedToFloat(pop32(h.thread)),
          source = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          aokanaLogicalStatus(
            managers.use(id, (manager) =>
              new AokanaLogicalSpatialQueries(manager).relativeToPosition(output, source, x, y, z),
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
