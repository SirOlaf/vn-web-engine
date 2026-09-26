import {pop32, push32} from '../bp/state.js';
import {worldMapPosition} from './world-map.js';
import type {BurikoNativeWorldMaps} from './world-map.js';
import type {BurikoBpOpcodeHandler, BurikoNativeSlotDefinition} from './types.js';

function status(result: number, mapping: Readonly<Record<number, number>>): number {
  return result === 0 ? 0 : (mapping[result] ?? 0xffffffff);
}
const nodeErrors = {0x80000007: 1, 0x8000000a: 2};

/** All eight DCWorldMapMngr leaves. The other D0 manager families register separately. */
export function createGroupD0WorldMap(maps: BurikoNativeWorldMaps): BurikoNativeSlotDefinition[] {
  const definitions: [number, number, string, BurikoBpOpcodeHandler][] = [
    [
      0xc0,
      0x1400d23c0,
      'CreateWorldMap',
      (h) => {
        const typeCount = pop32(h.thread),
          nodeCount = pop32(h.thread),
          output = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          status(maps.create(output, nodeCount, typeCount), {0x80000008: 5, 0x8000000a: 2}),
        );
        return 0;
      },
    ],
    [
      0xc1,
      0x1400d2370,
      'DestroyWorldMap',
      (h) => {
        push32(h.thread, status(maps.destroy(pop32(h.thread)), {0x80000007: 1}));
        return 0;
      },
    ],
    [
      0xc2,
      0x1400d2320,
      'ClearWorldMap',
      (h) => {
        push32(h.thread, status(maps.clear(pop32(h.thread)), {0x80000007: 1}));
        return 0;
      },
    ],
    [
      0xc4,
      0x1400d2290,
      'SetWorldMapNode',
      (h) => {
        const position = h.memory.resolve(h.thread, pop32(h.thread)),
          index = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, status(maps.setNode(id, index, worldMapPosition(position)), nodeErrors));
        return 0;
      },
    ],
    [
      0xc5,
      0x1400d2220,
      'RemoveWorldMapNode',
      (h) => {
        const index = pop32(h.thread),
          id = pop32(h.thread);
        push32(h.thread, status(maps.removeNode(id, index), nodeErrors));
        return 0;
      },
    ],
    [
      0xc6,
      0x1400d2140,
      'SetWorldMapEdge',
      (h) => {
        const overrides = h.memory.resolve(h.thread, pop32(h.thread)),
          count = pop32(h.thread),
          weight = pop32(h.thread),
          destination = pop32(h.thread),
          source = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          status(maps.setEdge(id, source, destination, weight, count, overrides), {
            ...nodeErrors,
            0x8000000c: 3,
            0x80000008: 4,
            0x8000000b: 5,
          }),
        );
        return 0;
      },
    ],
    [
      0xc7,
      0x1400d20b0,
      'RemoveWorldMapEdge',
      (h) => {
        const destination = pop32(h.thread),
          source = pop32(h.thread),
          id = pop32(h.thread);
        push32(
          h.thread,
          status(maps.removeEdge(id, source, destination), {...nodeErrors, 0x8000000c: 3}),
        );
        return 0;
      },
    ],
    [
      0xc8,
      0x1400d1fd0,
      'FindWorldMapPath',
      (h) => {
        const type = pop32(h.thread),
          destination = pop32(h.thread),
          source = pop32(h.thread),
          id = pop32(h.thread),
          path = h.memory.resolve(h.thread, pop32(h.thread)),
          count = h.memory.resolve(h.thread, pop32(h.thread));
        push32(
          h.thread,
          status(maps.findPath(count, path, id, source, destination, type), {
            ...nodeErrors,
            0x80000010: 6,
          }),
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
