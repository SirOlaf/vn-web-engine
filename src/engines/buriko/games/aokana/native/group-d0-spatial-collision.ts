import {pop32, push32} from '../bp/state.js';
import {aokanaFixedToFloat} from './logical-spatial.js';
import type {AokanaLogicalSpatialManagers} from './logical-spatial.js';
import {AokanaLogicalSpatialCollision} from './logical-spatial-collision.js';
import {aokanaLogicalStatus} from './logical-status.js';
import type {AokanaBpOpcodeHandler, AokanaNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialCollision(
  managers: AokanaLogicalSpatialManagers,
): AokanaNativeSlotDefinition[] {
  const definitions: [number, number, string, AokanaBpOpcodeHandler][] = [
    [
      0x70,
      0x1400d2e10,
      'CheckLogicalSpaceMovement',
      (h) => {
        const checkSegment = pop32(h.thread),
          mask = pop32(h.thread),
          z = aokanaFixedToFloat(pop32(h.thread)),
          y = aokanaFixedToFloat(pop32(h.thread)),
          x = aokanaFixedToFloat(pop32(h.thread)),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          aokanaLogicalStatus(
            managers.use(id, (manager) =>
              new AokanaLogicalSpatialCollision(manager).queryRecord(
                null,
                null,
                index,
                x,
                y,
                z,
                mask,
                checkSegment,
                true,
              ),
            ),
          ),
        );
        return 0;
      },
    ],
    [
      0x71,
      0x1400d2d00,
      'QueryLogicalSpaceMovementCollisions',
      (h) => {
        const checkSegment = pop32(h.thread),
          mask = pop32(h.thread),
          z = aokanaFixedToFloat(pop32(h.thread)),
          y = aokanaFixedToFloat(pop32(h.thread)),
          x = aokanaFixedToFloat(pop32(h.thread)),
          index = pop32(h.thread),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          aokanaLogicalStatus(
            managers.use(id, (manager) =>
              new AokanaLogicalSpatialCollision(manager).queryRecord(
                output,
                count,
                index,
                x,
                y,
                z,
                mask,
                checkSegment,
                false,
              ),
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
