import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime, literal} from './sc3-fixtures.mjs';
import {MemoryStore} from '../dist/platform/store.js';
import {StoredAchievements} from '../dist/platform/achievements.js';
import {awardNoahAchievement} from '../dist/engines/mages/games/chaos-head-noah/sc3/achievements.js';
test('music unlock writes exactly one byte and continues to the next instruction', async () => {
  const vm = runtime([0, 0x2c, ...literal(86), 0, 3]);
  await vm.boot();
  vm.state.bytes(0x17acbd0 + 85, 3).fill(0xa5);
  vm.runContext(0);
  assert.deepEqual([...vm.state.bytes(0x17acbd0 + 85, 3)], [0xa5, 1, 0xa5]);
  assert.equal(vm.pc(0), 27);
});
test('achievement selectors other than one consume no expression', async () => {
  for (const selector of [0, 2, 127, 128, 255]) {
    const vm = runtime([0, 0x2f, selector, 0, 3]);
    await vm.boot();
    vm.runContext(0);
    assert.equal(vm.pc(0), 21);
  }
});
test('Noah achievement completion cascades through 26 to 0 and persists', async () => {
  const store = new MemoryStore(),
    host = new StoredAchievements(store, 'noah');
  for (let i = 1; i < 34; i++) if (i !== 25 && i !== 26) host.unlock(i);
  awardNoahAchievement(host, 25);
  await host.settle();
  const restored = new StoredAchievements(store, 'noah');
  await restored.load();
  assert.ok(Array.from({length: 34}, (_, i) => restored.has(i)).every(Boolean));
});
test('unavailable achievement service ignores the native unsigned operand', () => {
  awardNoahAchievement(new StoredAchievements(undefined, 'noah'), 0xffffffff);
  assert.throws(
    () => awardNoahAchievement(new StoredAchievements(new MemoryStore(), 'noah'), 34),
    /Invalid Noah achievement/,
  );
});
test('explicit TIPS unlock reports freshness, appends once and preserves unrelated bits', async () => {
  const vm = runtime([
    16,
    0x27,
    1,
    ...literal(55),
    ...literal(1),
    0,
    3,
    16,
    0x27,
    1,
    ...literal(55),
    ...literal(1),
    0,
    3,
  ]);
  await vm.boot();
  vm.state.put(0x17adca0, 0);
  vm.state.auxiliary[20] = 0x81;
  vm.state.flags[0] = 0xa5;
  vm.runContext(0);
  assert.equal(vm.state.auxiliary[20], 0xa1);
  assert.equal(vm.state.flags[0], 0xa7);
  assert.equal(vm.state.get(0x5b0a3c), 1);
  assert.equal(vm.state.view(0x5a9840, 2).getUint16(0, true), 55);
  assert.equal(vm.state.variable(0x2430 / 4), 55);
  vm.runContext(0);
  assert.equal(vm.state.flags[0], 0xa5);
  assert.equal(vm.state.get(0x5b0a3c), 1);
});
test('scaled wait retries at the poll instruction and completes on the exact decrement', async () => {
  const vm = runtime([0, 0x4c, 0, ...literal(2), 0, 0x4c, 1, 0, 3]);
  await vm.boot();
  vm.state.put(0x17add38, 256);
  vm.state.put(0x17abc0c, 1);
  vm.state.put(0x17ac374, 2);
  vm.state.put(0x17ac284, 2);
  vm.runContext(0);
  assert.equal(vm.pc(0), 26);
  assert.equal(vm.state.get(0x17a0c88), 256);
  vm.runContext(0);
  assert.equal(vm.pc(0), 31);
  assert.equal(vm.state.get(0x17a0c88), 0);
});
