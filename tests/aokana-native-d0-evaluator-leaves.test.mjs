import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaLogicalGridManager} from '../dist/engines/buriko/games/aokana/native/logical-grid.js';
import {buildGridAbilityMaps} from '../dist/engines/buriko/games/aokana/native/logical-grid-derived.js';
import {
  gridEvaluatorAbilityRequest,
  gridEvaluatorAffinity,
  gridEvaluatorEffect,
  gridEvaluatorFacing,
  gridEvaluatorModifiers,
} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-math.js';
import {AokanaGridEvaluatorRecords} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-records.js';
import {chooseGridEvaluatorTarget} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-targets.js';
import {prepareGridEvaluation} from '../dist/engines/buriko/games/aokana/native/grid-evaluator-jobs.js';

function data(size) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {bytes, view, ptr: (offset = 0) => ({bytes, offset})};
}

test('grid sorted cells retain CRT equal-cost permutation, metric status and neighbor write order', () => {
  const manager = new AokanaLogicalGridManager(1),
    storage = data(1024);
  manager.setCells(3, 3, data(144).ptr());
  manager.createAgent(storage.ptr());
  const id = storage.view.getUint32(0, true);
  manager.setPosition(id, 1, 1);
  manager.search(id, 1, 2, -1, -1);
  manager.copyReachable(storage.ptr(64), storage.ptr(), id, true);
  assert.deepEqual(
    [...new Int32Array(storage.bytes.buffer, 64, 16)],
    [1, 0, 2, 1, 0, 1, 1, 2, 0, 2, 2, 0, 2, 2, 0, 0],
  );
  manager.copyMetric(storage.ptr(8), id, 0, 0);
  assert.equal(storage.view.getInt32(8, true), 2);
  manager.copyMetric(storage.ptr(8), id, 0, 0, true);
  assert.equal(storage.view.getInt32(8, true), 4);
  storage.bytes.fill(0x55, 128, 224);
  manager.copyNeighborPaths(storage.ptr(128), storage.ptr(160), id, 1, 1);
  assert.deepEqual([...new Int32Array(storage.bytes.buffer, 128, 6)], [1, 1, 1, 1, -1, -1]);
  assert.deepEqual([...new Int32Array(storage.bytes.buffer, 160, 8)], [1, 0, 1, 2, 0, 1, 2, 1]);
  assert.equal(storage.view.getUint32(192, true), 0x55555555);
  manager.copyRouteCoordinates(storage.ptr(256), storage.ptr(), id, 0, 0);
  assert.deepEqual([...new Int32Array(storage.bytes.buffer, 256, 4)], [1, 0, 0, 0]);
});

test('grid ability maps deduplicate exact requests and separate extended movement without changing cloned counters', () => {
  const manager = new AokanaLogicalGridManager(1),
    storage = data(2048),
    requests = data(60);
  manager.setCells(5, 1, data(80).ptr());
  manager.createAgent(storage.ptr());
  const id = storage.view.getUint32(0, true);
  manager.setPosition(id, 0, 0);
  const r = new Int32Array(requests.bytes.buffer);
  r.set([0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0]);
  assert.equal(buildGridAbilityMaps(manager, id, 1, 1, 3, requests.ptr(), 0, 1), 0);
  assert.equal(manager.agent(id).abilityMaps.length, 2);
  manager.copyAbilityMap(storage.ptr(128), id, requests.ptr(), 0);
  manager.copyAbilityMap(storage.ptr(512), id, requests.ptr(), 1);
  const ordinary = new Int32Array(storage.bytes.buffer, 128, 35),
    extended = new Int32Array(storage.bytes.buffer, 512, 35);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => ordinary[i * 7]),
    [1, 1, 1, 0, 0],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((i) => extended[i * 7]),
    [0, 1, 0, 1, 0],
  );
  assert.equal(ordinary[4], 1); // From x=1 towards x=0: direction 5.
  assert.equal(ordinary[7 + 3], 1); // From x=0 towards x=1: direction 4.
  assert.equal(manager.copyAbilityMap(null, id, requests.ptr(40), 1), 0x8000000e);
  const copy = manager.clone();
  assert.equal(copy.agent(id).path, null);
  assert.notEqual(
    copy.agent(id).abilityMaps[0].ordinary,
    manager.agent(id).abilityMaps[0].ordinary,
  );
  manager.agent(id).abilityMaps[0].ordinary.fill(99);
  assert.equal(copy.agent(id).abilityMaps[0].ordinary[0], 1);
  copy.addCostPlane(storage.ptr(), data(20).ptr());
  assert.equal(storage.view.getUint32(0, true), 1);
  copy.createAgent(storage.ptr());
  assert.equal(storage.view.getUint32(0, true), id); // Clone keeps constructor counter, even with copied IDs.
  assert.equal(copy.agent(id).x, -1);
  manager.clearAbilityMaps(id);
  assert.equal(manager.copyAbilityMap(null, id, null, 0), 0x8000000d);
  assert.equal(buildGridAbilityMaps(manager, id + 1, 1, 1, 0, null, 0, 0), 0x80000003);
});

test('grid evaluator native modifier outputs, record requests and arithmetic overflow remain distinct', () => {
  const source = data(0x834),
    target = data(0x834),
    output = data(64),
    additions = data(16);
  source.view.setInt32(0x144, 1, true);
  source.view.setInt32(0x1c4, 80, true);
  source.view.setInt32(0x148, 2, true);
  source.view.setInt32(0x1c8, 30, true);
  output.view.setInt32(4, 123, true);
  assert.equal(gridEvaluatorModifiers(output.ptr(), 2, source.ptr(), null), 0);
  assert.deepEqual([...new Int32Array(output.bytes.buffer, 0, 2)], [50, 123]);
  assert.equal(gridEvaluatorModifiers(output.ptr(), 99, null, null), 0x90000005);
  assert.deepEqual([...new Int32Array(output.bytes.buffer, 0, 2)], [0, 0]);
  for (let i = 0; i < 4; i++) {
    source.view.setInt32(i * 16, 100, true);
    source.view.setInt32(i * 16 + 4, 5, true);
    target.view.setInt32(i * 16 + 8, 3, true);
    target.view.setInt32(i * 16 + 12, 2, true);
  }
  gridEvaluatorEffect(
    output.ptr(),
    0,
    source.ptr(),
    additions.ptr(),
    1,
    target.ptr(),
    7,
    65536,
    65536,
  );
  assert.equal(output.view.getInt32(0, true), 764);
  source.view.setInt32(0, 0x40000000, true);
  source.view.setInt32(4, 4, true);
  gridEvaluatorEffect(
    output.ptr(),
    0,
    source.ptr(),
    additions.ptr(),
    0,
    target.ptr(),
    7,
    65536,
    65536,
  );
  assert.equal(output.view.getInt32(0, true), 471);
  for (let i = 0; i < 4; i++) source.view.setInt32(64 + i * 16 + 4, 0x7fffffff, true);
  gridEvaluatorEffect(
    output.ptr(),
    2,
    source.ptr(),
    additions.ptr(),
    0,
    null,
    0,
    0x7fffffff,
    0x7fffffff,
  );
  assert.equal(output.view.getInt32(0, true), 5);
  assert.equal(gridEvaluatorAbilityRequest(null, null, -1), 0x90000004);
  assert.equal(gridEvaluatorAbilityRequest(null, null, 17), 0x90000004);
  assert.equal(gridEvaluatorAbilityRequest(null, source.ptr(), 1), 0x90000004);
  source.view.setInt32(0x254, 7, true);
  gridEvaluatorAbilityRequest(output.ptr(), source.ptr(), 0);
  assert.deepEqual([...new Int32Array(output.bytes.buffer, 0, 5)], [0, 7, 0, 0, 0]);
  assert.equal(gridEvaluatorAffinity(1, 2, 3, [11, 22, 33]), 11);
  assert.equal(gridEvaluatorAffinity(1, 0, 3, [11, 22, 33]), 33);
  assert.equal(gridEvaluatorAffinity(1, 1, 3, [11, 22, 33]), 22);
  assert.equal(gridEvaluatorFacing(0, 2), 65536);
  assert.equal(gridEvaluatorFacing(180 * 65536, 2), 131072);
});

test('grid evaluator record initialization, target choice and candidates keep copied state and native metadata', () => {
  const grid = new AokanaLogicalGridManager(1),
    storage = data(64),
    actors = data(0x834 * 2),
    state = new AokanaGridEvaluatorRecords();
  grid.setCells(5, 1, data(80).ptr());
  for (let i = 0; i < 2; i++) {
    grid.createAgent(storage.ptr());
    const id = storage.view.getUint32(0, true),
      offset = i * 0x834;
    grid.setPosition(id, i === 0 ? 0 : 4, 0);
    grid.setDirection(id, i === 0 ? 5 : 4);
    for (const [word, value] of [
      [0, id],
      [1, 1 << i],
      [2, i],
      [3, -1],
      [7, 10],
      [8, 10],
      [0x8d, 1],
      [0x8e, 1],
      [0x95, 1],
    ])
      actors.view.setInt32(offset + word * 4, value, true);
  }
  assert.equal(state.initialize(grid, 0, null), 0x90000002);
  assert.equal(state.setTypeCount(0), 0x90000002);
  assert.equal(state.setTypeCount(3), 0);
  assert.equal(state.initialize(grid, 2, actors.ptr()), 0);
  assert.notEqual(state.grid, grid);
  assert.equal(state.record(0).word(0x20f), 3);
  assert.ok(state.record(0).map(0, false));
  assert.ok(state.record(0).map(0, true));
  assert.equal(state.record(0).map(1, false), null);
  assert.equal(chooseGridEvaluatorTarget(state, 0), 0);
  assert.deepEqual(
    [
      state.record(0).word(3),
      state.record(0).word(0x210),
      state.record(0).word(0x211),
      state.record(0).word(0x212),
      state.record(0).word(0x213),
    ],
    [1, 3, 0, 1, 0],
  );
  const candidates = prepareGridEvaluation(state, 0);
  assert.equal(candidates.jobs.length, 2);
  assert.deepEqual(
    [candidates.jobs.job(0).getInt32(0, true), candidates.jobs.job(1).getInt32(0, true)],
    [1, 0],
  );
  assert.deepEqual([...candidates.turnOrder], [1, -1]);
  assert.equal(grid.agent(state.record(0).id).x, 0);
  const oldMaps = state.record(0).maps.slice();
  assert.equal(state.update(0, data(0x834).ptr(), 1), 0);
  assert.deepEqual([state.record(0).x, state.record(0).y], [-1, -1]);
  assert.deepEqual(state.record(0).maps, oldMaps);
  assert.equal(state.copyRecord(null, 9), 0x90000003);
  state.initialize(null, 99, null);
  assert.equal(state.records.length, 0);
  assert.equal(state.grid, null);
  assert.equal(state.typeCount, 3);
});
