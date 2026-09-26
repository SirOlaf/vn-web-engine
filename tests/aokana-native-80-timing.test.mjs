import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaCrtRandom,
  AokanaVmFrameHistory,
  AokanaBrowserPerformanceCounter,
  nativeNanoseconds,
} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';

test('CRT random uses one shared 32-bit generator and exactly three draws for positive bounds', () => {
  const random = new AokanaCrtRandom();
  assert.deepEqual(
    Array.from({length: 5}, () => random.next()),
    [41, 18467, 6334, 26500, 19169],
  );
  random.seed(1);
  assert.equal(random.bounded(0), 0);
  assert.equal(random.bounded(0x80000000), 0);
  assert.equal(random.next(), 41);
  random.seed(1);
  assert.equal(random.bounded(1000), 286);
  assert.equal(random.next(), 26500);
  random.seed(0xffffffff);
  let state = 0xffffffffn;
  for (let count = 0; count < 200; count++) {
    state = (state * 214013n + 2531011n) & 0xffffffffn;
    assert.equal(random.next(), Number((state >> 16n) & 32767n));
  }
});

test('frame history keeps newest order across ring wrap, DWORD tick wrap and native restart', () => {
  const history = new AokanaVmFrameHistory(0xfffffffe),
    bytes = new Uint8Array(2400),
    pointer = {bytes, offset: 0};
  history.record(2);
  assert.equal(history.copy(pointer, 2), 1);
  assert.deepEqual([...new Uint32Array(bytes.buffer, 0, 2)], [4, 0]);
  assert.equal(history.copy(null, 0), 0);
  assert.equal(history.copy(null, 601), 0);
  assert.throws(() => history.copy(null, 1), /null destination/);
  for (let index = 1, now = 2; index <= 610; index++) {
    now += index;
    history.record(now);
  }
  history.copy(pointer, 600);
  assert.equal(new Uint32Array(bytes.buffer)[0], 610);
  assert.equal(new Uint32Array(bytes.buffer)[599], 11);
  history.clear();
  history.copy(pointer, 600);
  assert.equal(
    bytes.some((byte) => byte !== 0),
    false,
  );
  history.record(2 + (610 * 611) / 2 + 7);
  history.copy(pointer, 1);
  assert.equal(new Uint32Array(bytes.buffer)[0], 7);
});

test('performance timer preserves double operation order, separate fallbacks and CVTT overflow', () => {
  const clock = new AokanaNativeClock(() => 123);
  assert.equal(
    nativeNanoseconds({queryCounter: () => 3n, queryFrequency: () => 7n}, clock),
    428571428n,
  );
  assert.equal(
    nativeNanoseconds({queryCounter: () => null, queryFrequency: () => null}, clock),
    123000000n,
  );
  assert.equal(
    nativeNanoseconds({queryCounter: () => -3n, queryFrequency: () => 2n}, clock),
    -1500000000n,
  );
  assert.equal(
    nativeNanoseconds({queryCounter: () => 1n, queryFrequency: () => 0n}, clock),
    -(1n << 63n),
  );
  const browser = new AokanaBrowserPerformanceCounter({now: () => 12.34567});
  assert.equal(browser.queryCounter(), 12345n);
  assert.equal(browser.queryFrequency(), 1000000n);
});
