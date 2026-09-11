import test from 'node:test';
import assert from 'node:assert/strict';
import {frameBatch} from '../dist/core/frame-batch.js';
import {runtime} from './sc3-fixtures.mjs';
import {drawTitle} from '../dist/engines/mages/games/chaos-head-noah/sc3/title-draw.js';

test('fast-forward evaluates each native draw-state tick and keeps only its last presentation', async () => {
  const vm = runtime([0, 3, 0, 7, 0, 0]);
  await vm.boot();
  vm.state.setVariable(0x210c / 4, 1);
  vm.options.traceLimit = 5;
  let samples = 0;
  const frame = await frameBatch(
    async () => {
      samples++;
      vm.runFrame();
      return drawTitle(vm.state);
    },
    {frames: 8, milliseconds: 8, active: () => true, now: () => 0},
  );
  assert.equal(samples, 8);
  assert.equal(vm.state.get(0x5af94c), 8);
  assert.equal(frame[2].alpha, 64);
  assert.equal(vm.trace.length, 5);
  assert.equal(vm.trace.at(-1).operation, 'yield');
});
test('loading serializes accelerated ticks, cancellation prevents another pass or presentation', async () => {
  let release,
    active = true,
    calls = 0;
  const gate = new Promise((r) => (release = r));
  const pending = frameBatch(
    async () => {
      calls++;
      await gate;
      return 'frame';
    },
    {frames: 8, milliseconds: 8, active: () => active, now: () => 0},
  );
  await Promise.resolve();
  assert.equal(calls, 1);
  active = false;
  release();
  assert.equal(await pending, undefined);
  assert.equal(calls, 1);
});
test('time budget yields between complete passes without creating catch-up work', async () => {
  let time = 0,
    calls = 0;
  const result = await frameBatch(
    async () => {
      time += 5;
      return ++calls;
    },
    {frames: 8, milliseconds: 8, active: () => true, now: () => time},
  );
  assert.equal(result, 2);
  assert.equal(calls, 2);
});
