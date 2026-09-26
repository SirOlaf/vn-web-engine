import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeWorldMaps, worldMapPosition} from '../dist/engines/buriko/native/world-map.js';
import {createGroupD0WorldMap} from '../dist/engines/buriko/native/group-d0-world-map.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';

function fixture() {
  const bytes = new Uint8Array(1024),
    view = new DataView(bytes.buffer),
    maps = new BurikoNativeWorldMaps();
  const pointer = (offset) => ({bytes, offset});
  maps.create(pointer(0), 8, 4);
  const id = view.getUint32(0, true);
  const node = (index, x, y = 0, z = 0, w = 0) =>
    maps.setNode(id, index, new Float32Array([x, y, z, w]));
  const edge = (from, to, weight = 65536) => maps.setEdge(id, from, to, weight, 0, null);
  const path = (source, destination, type = -1, outputOffset = 100, countOffset = 4) => {
    const result = maps.findPath(
      pointer(countOffset),
      pointer(outputOffset),
      id,
      source,
      destination,
      type,
    );
    return {
      result,
      nodes:
        result === 0
          ? Array.from({length: view.getUint32(countOffset, true)}, (_, i) =>
              view.getUint32(outputOffset + i * 4, true),
            )
          : [],
    };
  };
  return {bytes, view, maps, pointer, id, node, edge, path};
}

test('world maps retain handles on failed creation and reset only after dimension validation', () => {
  const {maps, pointer, view, id, node} = fixture();
  assert.equal(maps.create(pointer(4), 0, 1), 0x8000000a);
  const invalidId = view.getUint32(4, true);
  assert.equal(invalidId, id + 1);
  assert.throws(() => maps.clear(invalidId), /uninitialized dimensions/);
  assert.equal(maps.destroy(invalidId), 0);
  assert.equal(maps.create(pointer(4), 1024, 1), 0x80000008);
  assert.equal(maps.create(pointer(4), 1024, 0), 0);
  assert.equal(maps.create(pointer(4), 1025, 32), 0x8000000a);
  assert.equal(maps.create(pointer(4), 1, 32), 0);
  assert.equal(maps.create(pointer(4), 1, 33), 0x80000008);
  node(0, 1);
  assert.equal(maps.removeNode(id, 0), 0);
  assert.equal(maps.removeNode(id, 0), 0x8000000a);
  assert.equal(maps.clear(id), 0);
  assert.equal(maps.destroy(id), 0);
  assert.equal(maps.destroy(id), 0x80000007);
});

test('world-map FIFO relaxation preserves ascending tie order and excludes the source from paths', () => {
  const {node, edge, path, maps, id} = fixture();
  node(0, 0, 0);
  node(1, 1, 1);
  node(2, 1, -1);
  node(3, 2, 0);
  edge(0, 2);
  edge(0, 1);
  edge(2, 3);
  edge(1, 3);
  assert.deepEqual(path(0, 3), {result: 0, nodes: [1, 3]});
  // Replacing a node destroys its outgoing edges but preserves incoming links.
  node(1, 1, 1);
  assert.deepEqual(path(0, 3), {result: 0, nodes: [2, 3]});
  assert.equal(maps.removeNode(id, 2), 0);
  assert.deepEqual(path(0, 3), {result: 0x80000010, nodes: []});
  assert.equal(path(0, 0).result, 0x80000010);
  assert.equal(path(7, 0).result, 0x8000000a);
  assert.equal(path(0, 8).result, 0x80000010);
});

test('world-map packed overrides replace duplicates, use signed count and validate in native order', () => {
  const {node, edge, path, maps, pointer, view, id} = fixture();
  node(0, 0);
  node(1, 1, 1);
  node(2, 1, -1);
  node(3, 2);
  edge(0, 1);
  edge(0, 2);
  edge(1, 3);
  edge(2, 3);
  view.setUint32(200, (65536 << 8) | 2, true);
  view.setUint32(204, (196608 << 8) | 2, true);
  assert.equal(maps.setEdge(id, 0, 1, 65536, 2, pointer(200)), 0);
  assert.deepEqual(path(0, 3, 2).nodes, [2, 3]);
  assert.deepEqual(path(0, 3, 3).nodes, [1, 3]);
  assert.equal(maps.setEdge(999, -1, -1, 0, 1, null), 0x80000007);
  assert.throws(() => maps.setEdge(id, -1, -1, 0, 1, null), /null edge overrides/);
  assert.equal(maps.setEdge(id, -1, -1, 0, 0, null), 0x8000000a);
  assert.equal(maps.setEdge(id, 0, -1, 0, 0, null), 0x8000000c);
  assert.equal(maps.setEdge(id, 0, 1, 0, 0, null), 0x80000008);
  view.setUint32(200, 4, true);
  assert.equal(maps.setEdge(id, 0, 1, 65536, 1, pointer(200)), 0x8000000b);
  view.setUint32(200, 3, true);
  assert.equal(maps.setEdge(id, 0, 1, 65536, 1, pointer(200)), 0x80000008);
  assert.equal(maps.setEdge(id, 0, 1, 65536, 0xffffffff, null), 0);
});

test('world-map positions use signed SIMD conversion and output aliasing writes count first', () => {
  const {node, edge, maps, pointer, view, id} = fixture();
  const values = [-2147483648, 2147483647, 16777217, -16777217];
  values.forEach((value, i) => view.setInt32(200 + i * 4, value, true));
  assert.deepEqual([...worldMapPosition(pointer(200))], [-32768, 32768, 256, -256]);
  node(0, 0);
  node(1, 1);
  node(2, 2);
  edge(0, 1);
  edge(1, 2);
  assert.equal(maps.findPath(pointer(100), pointer(100), id, 0, 2, 0), 0);
  assert.deepEqual([view.getUint32(100, true), view.getUint32(104, true)], [1, 2]);
  assert.throws(() => maps.findPath(pointer(4), null, id, 0, 2, 0), /null path output/);
  assert.equal(view.getUint32(4, true), 2);
});

test('all world-map VM leaves preserve argument order, status mappings and early position reads', () => {
  const {bytes, view, maps} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new BurikoBpMemory(bytes),
    definitions = createGroupD0WorldMap(maps),
    h = {thread, memory};
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  assert.equal(call(0xc0, 16, 8, 4), 0);
  const id = view.getUint32(16, true);
  assert.equal(call(0xc4, id, 0, 200), 0);
  view.setInt32(200, 65536, true);
  assert.equal(call(0xc4, id, 1, 200), 0);
  assert.equal(call(0xc6, id, 0, 1, 65536, 0, 0), 0);
  assert.equal(call(0xc8, 20, 100, id, 0, 1, 0), 0);
  assert.equal(view.getUint32(20, true), 1);
  assert.equal(view.getUint32(100, true), 1);
  assert.equal(call(0xc7, id, 0, 1), 0);
  assert.equal(call(0xc7, id, 0, 1), 3);
  assert.equal(call(0xc5, id, 1), 0);
  assert.equal(call(0xc5, id, 1), 2);
  assert.equal(call(0xc2, id), 0);
  assert.equal(call(0xc1, id), 0);
  assert.equal(call(0xc1, id), 1);
  assert.throws(() => call(0xc4, id, 0, 0), /null position input/);
  assert.equal(thread.stackIndex, 0);
});
