import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalGridManager,
  AokanaLogicalGridManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-grid.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaGridEvaluator} from '../dist/engines/buriko/games/aokana/native/grid-evaluator.js';
import {AokanaGridEvaluatorRecords} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-records.js';
import {AokanaGridEvaluationWorkers} from '../dist/engines/buriko/games/aokana/native/grid-evaluation-workers.js';
import {simulateGridEvaluation} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-simulation.js';
import {createGroupD0Evaluator} from '../dist/engines/buriko/games/aokana/native/group-d0-evaluator.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function storage(size) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {bytes, view, pointer: (offset = 0) => ({bytes, offset})};
}

function actorsFixture(positions = [0, 4], grid = new AokanaLogicalGridManager(1)) {
  const input = storage(0x834 * positions.length),
    output = storage(16);
  grid.setCells(5, 1, storage(80).pointer());
  for (let i = 0; i < positions.length; i++) {
    grid.createAgent(output.pointer());
    const id = output.view.getUint32(0, true);
    grid.setPosition(id, positions[i], 0);
    grid.setDirection(id, i === 0 ? 5 : 4);
    for (const [word, value] of [
      [0, id],
      [1, 1 << i],
      [2, 0],
      [3, -1],
      [7, 10],
      [8, 20],
      [0x8d, 1],
      [0x8e, 1],
      [0x95, 1],
    ])
      input.view.setInt32(i * 0x834 + word * 4, value, true);
  }
  return {grid, input};
}

function simulation(kind, changes = [], targetChanges = [], jobChanges = [], order = [-1]) {
  const {grid, input} = actorsFixture([1, 2]),
    state = new AokanaGridEvaluatorRecords(),
    job = storage(76);
  for (const [word, value] of changes) input.view.setInt32(word * 4, value, true);
  for (const [word, value] of targetChanges) input.view.setInt32(0x834 + word * 4, value, true);
  state.setTypeCount(3);
  state.initialize(grid, 2, input.pointer());
  // A unit-affinity pair isolates the simulation's score and cap rules from affinity multiplication.
  const words = new Int32Array(job.bytes.buffer);
  words.set([1, 0, kind, 0, 2, 0, -0x80000000, -1, -1, 0, 0, 0, 0]);
  words.fill(-0x80000000, 13);
  for (const [word, value] of jobChanges) words[word] = value;
  const copy = state.requireGrid().clone();
  simulateGridEvaluation(state, copy, 0, job.view, Int32Array.from(order));
  return {words, state, copy};
}

test('evaluator scores ordinary actions and outgoing capped attacks without mutating source actors', () => {
  let result = simulation(
    0,
    [
      [0x95, 2],
      [0x94, 17],
      [0x92, 3],
      [0xac, -2],
      [4, 11],
      [5, 2],
    ],
    [],
    [
      [9, 2],
      [10, -1],
      [12, 1],
    ],
  );
  assert.deepEqual([...result.words.slice(13)], [30, 30, 30, 30, -0x80000000, -0x80000000]);
  result = simulation(6, [
    [0x98, 2],
    [0x1c, 20],
    [0x9f, 7],
    [0xa0, 3],
    [0xa1, 100],
  ]);
  assert.deepEqual(
    [...result.words.slice(13)],
    [-0x80000000, -0x80000000, -0x80000000, 137, -0x80000000, -0x80000000],
  );
  assert.equal(result.state.record(1).word(7), 10);
  result = simulation(
    6,
    [
      [0x98, 2],
      [0x1c, 20],
      [0x9f, 7],
      [0xa0, 3],
      [0xa1, 100],
    ],
    [[7, -5]],
  );
  assert.equal(result.words[16], 92); // Negative native HP is also the outgoing cap.
});

test('evaluator ability branches retain healing/status caps, group coefficients and wrapped scores', () => {
  const common = [
    [0xad, 1],
    [0xb0, 2],
    [0x1c, 6],
    [0xb7, 1],
    [0xba, 0],
    [0xc0, 7],
    [0xc1, 3],
    [0xc2, 100],
  ];
  assert.equal(simulation(7, [...common, [0xae, 0]]).words[16], 25);
  assert.equal(simulation(7, [...common, [0xae, 0]], [[7, 5]]).words[16], 122);
  assert.equal(simulation(7, [...common, [0xae, 1]], [[7, 18]]).words[16], 13);
  assert.equal(simulation(7, [...common, [0xae, 2], [0xaf, 2]], [[0x4f, 4]]).words[16], 19);
  assert.equal(simulation(7, [...common, [0xae, 3], [0xaf, 2], [0xb5, 9]]).words[16], 25);
  assert.equal(simulation(7, [...common, [0xae, 4], [0xaf, 2], [0xb5, 9]]).words[16], 25);
  assert.equal(simulation(7, [...common, [0xae, 99]]).words[16], 0);
  assert.equal(
    simulation(7, [...common, [0xae, 1], [0xbd, 19], [0xbe, 5]], [[1, 1]]).words[16],
    49,
  );
  assert.equal(simulation(7, [...common, [0xba, -1], [0x9f, 71]]).words[16], 71);
  assert.equal(simulation(7, [...common, [0xae, 0], [0xc1, 0x40000000]]).words[16], -2147483641);
});

test('evaluator incoming damage is added, percentage multiplication wraps, and kill bonuses occur once', () => {
  const changes = [
      [0x93, 100],
      [0xa2, 7],
      [0xa3, 3],
      [0xa4, 100],
    ],
    enemy = [
      [0x98, 2],
      [0x1c, 20],
    ];
  let result = simulation(0, changes, enemy, [], [1, -1]);
  // Ordinary damage is not capped to the selected actor's ten HP.
  assert.deepEqual([...result.words.slice(13, 17)], [182, 182, 227, 167]);
  assert.equal(result.state.record(0).word(7), 10);
  result = simulation(
    0,
    [
      [0x93, 100],
      [0xa2, 0x40000001],
      [0xa3, 0],
    ],
    [[0x98, 2]],
    [],
    [1, -1],
  );
  assert.deepEqual([...result.words.slice(13, 17)], [1, 1, 1, 1]); // (0x40000001 * 100) wraps to 100.
  result = simulation(
    0,
    [...changes, [0xa5, 11], [0xa6, 2], [0xa7, 100]],
    [...enemy, [0xad, 1], [0xae, 0], [0xb0, 2], [0xb7, 1]],
    [],
    [1, -1],
  );
  assert.deepEqual([...result.words.slice(13, 17)], [243, 243, 318, 218]); // The second hit has no second kill bonus.
});

test('evaluator incoming abilities and area actions follow each native behavior path', () => {
  const changes = [
      [0x93, 100],
      [0xa5, 7],
      [0xa6, 3],
      [0xa7, 100],
      [0xa8, 17],
      [0xa9, 5],
    ],
    enemy = [
      [0x95, 0],
      [0xad, 1],
      [0xaf, 2],
      [0xb0, 2],
      [0x1c, 6],
      [0xb5, 10],
      [0xb7, 1],
    ];
  let result = simulation(0, changes, [...enemy, [0xae, 0]], [], [1, -1]);
  assert.deepEqual([...result.words.slice(13, 17)], [28, 28, 143, 25]);
  result = simulation(0, changes, [...enemy, [0xae, 4]], [], [1, -1]);
  assert.deepEqual([...result.words.slice(13, 17)], [47, 47, 47, 47]);
  result = simulation(
    7,
    [
      [0xad, 1],
      [0xae, 1],
      [0xb0, 2],
      [0x1c, 6],
      [0xb7, 1],
      [0xba, 1],
      [0xbd, 19],
      [0xbe, 5],
      [0xc0, 7],
      [0xc1, 3],
    ],
    [],
    [
      [4, 1],
      [5, 0],
    ],
  );
  assert.equal(result.words[16], 74); // Self-centered area heals both the selected actor and its neighbor.
});

test('full evaluator ranks copied jobs through every configured worker and preserves output bounds', () => {
  const {grid, input} = actorsFixture(),
    allocator = new AokanaDistributedAllocator(4),
    state = new AokanaGridEvaluator(allocator, 3),
    output = storage(1024);
  state.setTypeCount(3);
  assert.equal(state.initialize(grid, 2, input.pointer()), 0);
  assert.equal(state.evaluate(null, null, 2, 0), 0x90000003);
  output.bytes.fill(0x55);
  assert.equal(state.evaluate(output.pointer(16), output.pointer(), 0, 3), 0);
  assert.equal(output.view.getUint32(0, true), 3);
  assert.equal(output.view.getUint32(16 + 3 * 28, true), 0x55555555);
  for (let i = 0; i < 3; i++) {
    const offset = 16 + i * 28;
    assert.ok([0, 1].includes(output.view.getInt32(offset, true)));
    assert.equal(output.view.getInt32(offset + 4, true), 0);
    assert.ok(output.view.getInt32(offset + 8, true) < 4);
  }
  assert.equal(state.evaluate(null, output.pointer(), 0, 0), 0);
  assert.equal(output.view.getUint32(0, true), 0);
  state.dispose();
  assert.equal(state.grid, null);
});

test('full evaluator enumerates ordinary attacks, targeted abilities and untargeted abilities together', () => {
  const {grid, input} = actorsFixture([1, 2]),
    allocator = new AokanaDistributedAllocator(2),
    state = new AokanaGridEvaluator(allocator, 2),
    output = storage(8192);
  for (const [word, value] of [
    [0x98, 2],
    [0x1c, 2],
    [0x9f, 7],
    [0xa0, 3],
    [0xad, 1],
    [0xae, 0],
    [0xb0, 2],
    [0xb7, 1],
    [0xc0, 11],
    [0xc1, 5],
    [0xad + 22, 1],
    [0xae + 22, 3],
    [0xba + 22, -1],
  ])
    input.view.setInt32(word * 4, value, true);
  state.setTypeCount(3);
  state.initialize(grid, 2, input.pointer());
  assert.equal(state.evaluate(output.pointer(16), output.pointer(), 0, 64), 0);
  const count = output.view.getUint32(0, true),
    kinds = new Set(),
    abilities = new Set();
  assert.ok(count > 4 && count < 64);
  for (let i = 0; i < count; i++) {
    const offset = 16 + i * 28,
      kind = output.view.getInt32(offset + 8, true);
    kinds.add(kind);
    if (kind === 7) abilities.add(output.view.getInt32(offset + 12, true));
  }
  assert.deepEqual([...kinds].sort(), [0, 1, 2, 3, 6, 7]);
  assert.deepEqual([...abilities].sort(), [0, 1]);
  state.dispose();
});

test('all nine evaluator VM wrappers preserve pop order, independent progress and consuming statuses', async () => {
  const allocator = new AokanaDistributedAllocator(3),
    main = new AokanaDistributedProcessing(allocator, 2),
    grids = new AokanaLogicalGridManagers(),
    memory = new AokanaBpMemory(new Uint8Array(16384));
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory},
    bytes = memory.globalMemory,
    pointer = (offset) => ({bytes, offset}),
    view = new DataView(bytes.buffer);
  grids.create(pointer(4), 0, 1);
  const gridId = view.getUint32(4, true),
    {input} = actorsFixture([0, 4], grids.get(gridId));
  bytes.set(input.bytes, 1024);
  const workers = new AokanaGridEvaluationWorkers(allocator, main, grids),
    slots = new Map(createGroupD0Evaluator(workers).map((slot) => [slot.secondary, slot.execute]));
  assert.equal(slots.size, 9);
  const invoke = async (slot, values, hasResult = true) => {
    for (const value of values) push32(thread, value);
    assert.equal(await slots.get(slot)(context), 0);
    const result = hasResult ? pop32(thread) : undefined;
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  await invoke(0x80, [32], false);
  const id = view.getUint32(32, true);
  assert.equal(id, 1);
  assert.equal(await invoke(0x87, [64, id]), 0);
  assert.equal(view.getUint32(64, true), 0);
  assert.equal(await invoke(0x87, [64, id]), 0);
  assert.equal(view.getUint32(64, true), 0xffff0000);
  assert.equal(await invoke(0x84, [id, 3]), 0);
  assert.equal(await invoke(0x88, [id, gridId, 2, 1024, 1]), 0);
  assert.equal(workers.hasPendingWork(), true);
  assert.equal(await invoke(0x87, [64, id]), 14);
  assert.equal(await invoke(0x8e, [8192, id, 0]), 14);
  bytes.fill(0, 1024, 1024 + input.bytes.length); // Queue owns the copied actor payload.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(workers.hasPendingWork(), false);
  assert.equal(await invoke(0x87, [64, id]), 0);
  assert.equal(view.getUint32(64, true), 0);
  assert.equal(await invoke(0x8e, [8192, id, 0]), 0);
  assert.equal(view.getUint32(8192, true), input.view.getUint32(0, true));
  assert.equal(await invoke(0x8c, [id, gridId]), 0);
  bytes.set(input.bytes.subarray(0, 0x834), 1024);
  assert.equal(await invoke(0x8d, [id, 0, 1024, 0, 0]), 0);
  assert.equal(await invoke(0x8a, [5120, 64, id, 0, 2]), 0);
  assert.equal(workers.hasPendingWork(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.getUint32(64, true), 2);
  assert.equal(await invoke(0x8d, [id, 99, 1024, 0, 1]), 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await invoke(0x87, [64, id]), 0);
  assert.equal(view.getUint32(64, true), 17);
  assert.equal(await invoke(0x81, [id]), 0);
  assert.equal(await invoke(0x81, [id]), 1);
  main.dispose();
});

test('queued initialization preserves a destroyed native grid as an access fault', async () => {
  const allocator = new AokanaDistributedAllocator(1),
    main = new AokanaDistributedProcessing(allocator, 1),
    grids = new AokanaLogicalGridManagers(),
    output = storage(16),
    workers = new AokanaGridEvaluationWorkers(allocator, main, grids);
  grids.create(output.pointer(), 0, 1);
  const gridId = output.view.getUint32(0, true);
  grids.get(gridId).setCells(1, 1, storage(16).pointer());
  workers.create(output.pointer());
  const workerId = output.view.getUint32(0, true);
  assert.equal(workers.initialize(workerId, gridId, 1, storage(0x834).pointer(), 1), 0);
  grids.destroy(gridId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.throws(() => workers.hasPendingWork(), /destroyed manager/);
  assert.throws(() => workers.takeStatus(output.pointer(), workerId), /destroyed manager/);
  main.dispose();
});
