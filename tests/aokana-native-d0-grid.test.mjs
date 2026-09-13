import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalGridManager,
  AokanaLogicalGridManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-grid.js';
import {AokanaLogicalGridPath} from '../dist/engines/buriko/games/aokana/native/logical-grid-path.js';
import {AokanaLogicalGridVisibility} from '../dist/engines/buriko/games/aokana/native/logical-grid-visibility.js';
import {AokanaNativeSpline} from '../dist/engines/buriko/games/aokana/native/spline.js';
import {createGroupD0Grid} from '../dist/engines/buriko/games/aokana/native/group-d0-grid.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function fixture(width = 3, height = 3) {
  const manager = new AokanaLogicalGridManager(1),
    bytes = new Uint8Array(4096),
    view = new DataView(bytes.buffer),
    pointer = (offset) => ({bytes, offset}),
    cells = new Uint8Array(width * height * 16);
  manager.setCells(width, height, {bytes: cells, offset: 0});
  const create = (x, y) => {
    manager.createAgent(pointer(16));
    const id = view.getUint32(16, true);
    manager.setPosition(id, x, y);
    return id;
  };
  return {manager, bytes, view, pointer, create};
}

test('grid handles, validation order, copied cells and agent defaults retain native lifetime', () => {
  const {manager, pointer, view, create} = fixture(),
    registry = new AokanaLogicalGridManagers();
  assert.equal(registry.create(null, 1, 0), 0);
  assert.equal(registry.create(pointer(32), 0, 7), 1);
  assert.equal(view.getUint32(32, true), 0);
  assert.equal(registry.get(0).verticalDivisor, 7);
  assert.equal(registry.destroy(0), 1);
  assert.equal(registry.destroy(0), 0);
  assert.throws(() => registry.create(null, 0, 1), /null output/);
  assert.ok(registry.get(1));
  const id = create(1, 1),
    agent = manager.agent(id);
  assert.equal(id, 0x20000000);
  assert.deepEqual(
    [agent.height, agent.width, agent.direction, agent.occupancyHeight],
    [3, 128, 0, 1],
  );
  assert.equal(manager.setPosition(id + 1, -1, -1), 0x80000003);
  assert.equal(manager.setPosition(id, -1, 1), 0x80000004);
  assert.equal(manager.setSize(id, -1, -1), 0x80000009);
  assert.equal(manager.setSize(id, 1, -1), 0x8000000a);
  assert.equal(manager.setDirection(id, 1), 0x8000000b);
  assert.equal(manager.setMasks(id + 1, null), 0x80000003);
  assert.throws(() => manager.setMasks(id, null), /null agent mask/);
  assert.equal(manager.selectCostPlane(id, 0), 0x80000005);
  assert.equal(manager.setCells(0, 0, null), 0x80000001);
  assert.ok(manager.agent(id));
  manager.setCells(1, 1, pointer(128));
  assert.equal(manager.agent(id), undefined);
  assert.equal(create(0, 0), 0x20000001);
});

test('grid FIFO stores native search tuples and reconstructs inverse directions with count first', () => {
  const {manager, create, pointer, bytes, view} = fixture(),
    id = create(1, 1);
  assert.equal(manager.copyRoute(null, null, id, 0, 0), 0x80000006);
  assert.equal(manager.search(id, 1, 2, -1, -1), 0);
  assert.equal(manager.copyResults(pointer(128), id), 0);
  assert.deepEqual([...new Int32Array(bytes.buffer, 128 + 4 * 24, 6)], [1, 1, 0, 0, 0, 0]);
  assert.deepEqual([...new Int32Array(bytes.buffer, 128, 6)], [1, 5, 2, 2, 0, 2]);
  assert.equal(manager.copyRoute(pointer(32), pointer(32), id, 0, 0), 0);
  assert.deepEqual([...new Int32Array(bytes.buffer, 32, 2)], [2, 4]);
  assert.equal(manager.copyRoute(null, pointer(16), id, 0, 0), 0);
  assert.equal(view.getInt32(16, true), 2);
  assert.equal(manager.copyReachable(pointer(512), pointer(16), id), 0);
  assert.equal(view.getInt32(16, true), 8);
  assert.deepEqual(
    [...new Int32Array(bytes.buffer, 512, 16)],
    [0, 0, 1, 0, 2, 0, 0, 1, 2, 1, 0, 2, 1, 2, 2, 2],
  );
  assert.equal(manager.copyRoute(null, null, id, 99, 0), 0x80000007);
  assert.throws(() => manager.copyRoute(pointer(32), null, id, 0, 0), /null output/);
  assert.equal(manager.clearPath(id), 0);
  assert.equal(manager.copyResults(null, id), 0x80000006);
});

test('grid movement preserves budget, climb, occupancy, stop masks and unplaced-agent access faults', () => {
  const {manager, create, pointer, view} = fixture(3, 1),
    id = create(0, 0);
  manager.cell(1, 0).setInt32(0, 2, true);
  assert.equal(manager.search(id, 1, 9, -1, -1), 0);
  assert.equal(manager.copyRoute(null, pointer(16), id, 1, 0), 0x80000007);
  manager.search(id, 2, 1, -1, -1);
  assert.equal(manager.copyRoute(null, pointer(16), id, 1, 0), 0x80000007);
  view.setUint32(32, 4, true);
  manager.setMasks(id, pointer(32));
  manager.search(id, 2, 1, -1, -1);
  assert.equal(manager.copyRoute(null, pointer(16), id, 1, 0), 0);
  assert.equal(manager.copyRoute(null, pointer(16), id, 2, 0), 0x80000007);
  manager.cell(1, 0).setInt32(0, 0, true);
  const second = create(1, 0);
  manager.search(id, 9, 9, -1, -1);
  assert.equal(manager.copyRoute(null, pointer(16), id, 1, 0), 0x80000007);
  view.setUint32(32, 1, true);
  manager.setMasks(id, pointer(32));
  manager.search(id, 9, 9, -1, -1);
  assert.equal(manager.copyRoute(null, pointer(16), id, 2, 0), 0);
  manager.removeAgent(second);
  manager.createAgent(pointer(16));
  assert.throws(() => manager.search(id, 9, 9, -1, -1), /exceeds its byte view/);
  const path = new AokanaLogicalGridPath(0),
    cells = new Uint8Array(48);
  new DataView(cells.buffer).setUint32(16 + 12, 1, true);
  path.setCells(3, 1, cells);
  path.search(0, 0, [0, 0], 3, 10, -1, -1);
  assert.equal(path.copyRoute(null, pointer(16), 1, 0), 0);
  assert.equal(path.copyRoute(null, pointer(16), 2, 0), 0x80000004);
});

test('spline boundary, wrapped linear difference, natural cubic and point limit match native branches', () => {
  const spline = new AokanaNativeSpline(),
    output = new Int32Array(3).fill(99);
  assert.equal(spline.sample(0, output), false);
  assert.deepEqual([...output], [0, 0, 0]);
  spline.append(10, 20, 30);
  spline.setDuration(10);
  assert.equal(spline.sample(3, output), true);
  assert.deepEqual([...output], [10, 20, 30]);
  spline.append(30, 40, 50);
  spline.sample(5, output);
  assert.deepEqual([...output], [20, 30, 40]);
  spline.sample(10, output);
  assert.deepEqual([...output], [30, 40, 50]);
  spline.clear();
  spline.append(0x7fffffff, 0, 0);
  spline.append(-0x80000000, 0, 0);
  spline.setDuration(2);
  spline.sample(1, output);
  assert.equal(output[0], 0x7fffffff);
  spline.clear();
  spline.append(0, 0, 0);
  spline.append(8, 16, -8);
  spline.append(0, 0, 0);
  spline.setDuration(8);
  spline.sample(2, output);
  assert.deepEqual([...output], [5, 11, -5]);
  spline.sample(4, output);
  assert.deepEqual([...output], [8, 16, -8]);
  for (let i = 3; i < 100; i++) assert.equal(spline.append(0, 0, 0), true);
  assert.equal(spline.append(1, 1, 1), false);
});

test('grid visibility uses spline terrain samples, source flags, threshold bounds and four-word corners', () => {
  const {manager, pointer, view, bytes} = fixture(3, 1),
    visibility = new AokanaLogicalGridVisibility(manager);
  assert.equal(visibility.lineOfSight(null, 0, 0, 0, 0, 0, 0), 0x80000004);
  assert.equal(visibility.lineOfSight(null, 0, 0, 3, 0, 0, 0), 0x80000008);
  visibility.lineOfSight(pointer(16), 0, 0, 2, 0, 0, 0);
  assert.equal(view.getInt32(16, true), 1);
  manager.cell(1, 0).setInt32(0, 2, true);
  visibility.lineOfSight(pointer(16), 0, 0, 2, 0, 0, 0);
  assert.equal(view.getInt32(16, true), 0);
  visibility.lineOfSight(pointer(16), 0, 0, 2, 0, 256, 0);
  assert.equal(view.getInt32(16, true), 1);
  manager.cell(1, 0).setInt32(0, 0, true);
  visibility.collect(pointer(32), pointer(128), pointer(16), 0, 0, 3, 0, 0, 0, 0);
  assert.equal(view.getInt32(16, true), 2);
  assert.deepEqual([...new Int32Array(bytes.buffer, 32, 4)], [1, 0, 2, 0]);
  assert.deepEqual([...new Int32Array(bytes.buffer, 128, 2)], [65536, 131072]);
  manager.cell(2, 0).setUint32(8, 4, true);
  visibility.lineOfSight(pointer(16), 2, 0, 0, 0, 0, 0);
  assert.equal(view.getInt32(16, true), 0);
  manager.cell(1, 0).setInt32(0, 32, true);
  assert.throws(
    () => visibility.collect(null, null, null, 0, 0, 1, 0, 0, 0, 0),
    /height-threshold stack/,
  );
  const corners = new AokanaLogicalGridManager(1),
    cells = new Uint8Array(64),
    source = new DataView(cells.buffer);
  source.setInt32(0, 2, true);
  source.setInt32(48, 3, true);
  corners.setCells(2, 2, {bytes: cells, offset: 0});
  assert.deepEqual(
    [...new Int32Array(corners.corners.buffer)],
    [0, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0],
  );
});

test('all nineteen D0 grid wrappers consume the verified native arguments and map statuses', () => {
  const {bytes, view} = fixture(),
    managers = new AokanaLogicalGridManagers(),
    definitions = createGroupD0Grid(managers),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 128,
      moduleCapacity: 32,
      frameCapacity: 32,
    }),
    h = {thread, memory: new AokanaBpMemory(bytes)},
    call = (secondary, ...args) => {
      for (const arg of args) push32(thread, arg);
      assert.equal(definitions.find((entry) => entry.secondary === secondary).execute(h), 0);
      const result = pop32(thread);
      assert.equal(thread.stackIndex, 0);
      return result;
    };
  assert.equal(definitions.length, 19);
  assert.equal(call(0, 16, 0, 1), 1);
  const id = view.getUint32(16, true);
  assert.equal(call(4, id, 3, 3, 1024), 0);
  assert.equal(call(5, 20, id, 1280), 0);
  const plane = view.getUint32(20, true);
  assert.equal(call(0x10, 24, id), 0);
  const agent = view.getUint32(24, true);
  assert.equal(call(0x14, id, agent, 1, 1), 0);
  assert.equal(call(0x15, id, agent, 4, 160), 0);
  assert.equal(call(0x16, id, agent, 128), 0);
  assert.equal(call(0x17, id, agent, plane), 0);
  assert.equal(call(0x18, id, agent, 2), 0);
  assert.equal(call(0x20, id, agent, 1, 2, -1, -1), 0);
  assert.equal(call(0x21, 256, 28, id, agent, 0, 0), 0);
  assert.equal(view.getInt32(28, true), 2);
  assert.equal(call(0x22, 512, id, agent), 0);
  assert.equal(call(0x23, 256, 28, id, agent), 0);
  assert.equal(view.getInt32(28, true), 8);
  assert.equal(call(0x28, 256, 768, 28, id, 1, 1, 3, 0, 0, 0, 1), 0);
  assert.equal(view.getInt32(28, true), 8);
  assert.equal(call(0x2c, 32, 1, 0, id, agent), 0);
  assert.equal(view.getInt32(32, true), 0);
  assert.equal(call(0x2d, 32, id, 1, 0, 1, 1), 0);
  assert.equal(view.getInt32(32, true), 2);
  assert.equal(call(0x12, id, agent), 0);
  assert.equal(call(0x11, id, agent), 0);
  assert.equal(call(1, id), 1);
  assert.equal(call(4, id, 0, 0, 0), 1);
});
