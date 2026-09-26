import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {
  createGroup81Clock,
  createGroup81Random,
} from '../dist/engines/buriko/native/group-81-clock.js';

test('81 clock setters affect the shared native gap and suspension state', () => {
  let tick = 100;
  const clock = new BurikoNativeClock(() => tick);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const definitions = createGroup81Clock(clock);
  const call = (index, value) => {
    push32(thread, value);
    definitions[index].execute({thread});
    return pop32(thread);
  };
  assert.equal(clock.read(), 100n);
  assert.equal(call(0, 49), 0);
  assert.equal(call(0, 60001), 0);
  assert.equal(call(0, 60000), 1);
  assert.equal(call(0, 50), 1);
  tick = 151;
  assert.equal(clock.read(), 100n);
  assert.equal(call(1, 1), 0);
  assert.equal(call(1, 2), 1);
  clock.suspensionEnabled = true;
  assert.equal(clock.beginSuspension(false), true);
  tick = 180;
  assert.equal(clock.read(), 100n);
  assert.equal(clock.endSuspension(), true);
  assert.equal(clock.read(), 100n);
});

test('81 random keeps native modulo bias, signed bounds and zero entropy-call skip', () => {
  let draws = 0;
  const [definition] = createGroup81Random({
    getRandomValues(output) {
      draws++;
      output[0] = 0xffffffff;
      return output;
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  for (const [bound, result] of [
    [0, 0],
    [10, 5],
    [-10, 0xfffffffb],
    [-2147483648, 0x80000001],
    [1, 0],
  ]) {
    push32(thread, bound);
    assert.equal(definition.execute({thread}), 0);
    assert.equal(pop32(thread), result);
  }
  assert.equal(draws, 4);
});
