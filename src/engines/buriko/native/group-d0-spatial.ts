import {pop32, push32} from '../bp/state.js';
import {burikoFixedToFloat, writeBurikoSpatialVector} from './logical-spatial.js';
import type {BurikoLogicalSpatialManagers} from './logical-spatial.js';
import {burikoLogicalStatus} from './logical-status.js';
import type {BurikoBpOpcodeHandler, BurikoNativeSlotDefinition} from './types.js';

export function createGroupD0SpatialRecords(
  managers: BurikoLogicalSpatialManagers,
): BurikoNativeSlotDefinition[] {
  const definitions: [number, number, string, BurikoBpOpcodeHandler][] = [
    [
      0x40,
      0x1400d36a0,
      'CreateLogicalSpace',
      (h) => {
        push32(h.thread, managers.create(h.memory.resolve(h.thread, pop32(h.thread))));
        return 0;
      },
    ],
    [
      0x41,
      0x1400d3670,
      'DestroyLogicalSpace',
      (h) => {
        push32(h.thread, managers.destroy(pop32(h.thread)));
        return 0;
      },
    ],
    [
      0x60,
      0x1400d34a0,
      'CreateLogicalSpaceRecord',
      (h) => {
        const flags = pop32(h.thread),
          mask = pop32(h.thread),
          values: number[] = [];
        for (let i = 0; i < 9; i++) values.unshift(burikoFixedToFloat(pop32(h.thread)));
        const index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.createRecord(index, values, mask, flags)),
          ),
        );
        return 0;
      },
    ],
    [
      0x61,
      0x1400d3460,
      'RemoveLogicalSpaceRecord',
      (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          burikoLogicalStatus(managers.use(id, (manager) => manager.removeRecord(index))),
        );
        return 0;
      },
    ],
    [
      0x62,
      0x1400d3400,
      'SetLogicalSpaceProperty',
      (h) => {
        const value = pop32(h.thread),
          property = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.setProperty(index, property, value)),
          ),
        );
        return 0;
      },
    ],
    [
      0x63,
      0x1400d3380,
      'GetLogicalSpaceProperty',
      (h) => {
        const property = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.getProperty(output, index, property)),
          ),
        );
        return 0;
      },
    ],
    ...(
      [
        [0x64, 0x1400d32f0, 'SetLogicalSpacePosition'],
        [0x66, 0x1400d3150, 'SetLogicalSpaceDirection'],
      ] as const
    ).map(([secondary, address, name]): [number, number, string, BurikoBpOpcodeHandler] => [
      secondary,
      address,
      name,
      (h) => {
        const z = burikoFixedToFloat(pop32(h.thread)),
          y = burikoFixedToFloat(pop32(h.thread)),
          x = burikoFixedToFloat(pop32(h.thread)),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) =>
              secondary === 0x64
                ? manager.setPosition(index, x, y, z)
                : manager.setDirection(index, x, y, z),
            ),
          ),
        );
        return 0;
      },
    ]),
    ...(
      [
        [0x65, 0x1400d31e0, 'GetLogicalSpacePosition'],
        [0x67, 0x1400d3040, 'GetLogicalSpaceDirection'],
      ] as const
    ).map(([secondary, address, name]): [number, number, string, BurikoBpOpcodeHandler] => [
      secondary,
      address,
      name,
      (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        let vector: Float32Array | undefined;
        const result = managers.use(id, (manager) => {
          vector = manager.vector(index, secondary === 0x67);
          return vector === undefined ? 0xa0000001 : 0;
        });
        if (result === 0) writeBurikoSpatialVector(output, vector!);
        push32(h.thread, burikoLogicalStatus(result));
        return 0;
      },
    ]),
    [
      0x68,
      0x1400d2fe0,
      'SetLogicalSpaceParent',
      (h) => {
        const target = pop32(h.thread),
          group = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.setParent(index, group, target)),
          ),
        );
        return 0;
      },
    ],
    [
      0x69,
      0x1400d2f60,
      'GetLogicalSpaceParent',
      (h) => {
        const group = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.getParent(output, index, group)),
          ),
        );
        return 0;
      },
    ],
    [
      0x6a,
      0x1400d2ed0,
      'GetLogicalSpaceChildren',
      (h) => {
        const group = pop32(h.thread),
          index = pop32(h.thread),
          id = pop32(h.thread),
          count = h.memory.resolve(h.thread, pop32(h.thread)),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          burikoLogicalStatus(
            managers.use(id, (manager) => manager.copyChildren(output, count, index, group)),
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
