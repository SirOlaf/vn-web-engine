import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWaveSineRadians} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-math.js';
import {referenceSineCosine} from './aokana-trig-reference.mjs';

test('wave sine covers the signed phase and positive unsigned period domain through all three table windows', () => {
  const inputs = new Map(),
    add = (phase, period) => {
      if (!Number.isInteger(phase) || phase < -0x80000000 || phase > 0x7fffffff || period === 0)
        return;
      inputs.set(`${phase}/${period}`, [phase, period >>> 0]);
    },
    periods = [1, 2, 3, 7, 31, 255, 256, 65535, 0x7fffffff, 0x80000000, 0xffffffff];
  for (const period of periods) {
    for (const phase of [0, 1, -1, 0x7fffffff, -0x80000000]) add(phase, period);
    for (let exponent = 0; exponent < 32; exponent++)
      for (let delta = -2; delta <= 2; delta++) {
        add(2 ** exponent + delta, period);
        add(-(2 ** exponent) + delta, period);
      }
  }
  for (const radians of [
    0.7853981633974483,
    500000,
    ...Array.from({length: 15}, (_, index) => 2 ** (19 + index)),
  ]) {
    for (const period of [1, 3, 7]) {
      const phase = Math.round(radians / (6.283185307179586 / period));
      for (let delta = -5; delta <= 5; delta++) {
        add(phase + delta, period);
        add(-phase + delta, period);
      }
    }
  }
  let seed = 0xa61e3972;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let index = 0; index < 16000; index++) {
    const phase = next() | 0,
      period = index % 2 === 0 ? (next() & 65535) + 1 : next() || 1;
    add(phase, period);
  }
  const exponents = new Set();
  for (const [phase, period] of inputs.values()) {
    const radians = phase * (6.283185307179586 / period),
      actual = nativeWaveSineRadians(radians),
      expected = referenceSineCosine(radians).sine;
    if (Math.abs(radians) >= 500000) exponents.add(Math.floor(Math.log2(Math.abs(radians))));
    assert.ok(
      Math.abs(actual - expected) <= Math.max(1e-30, Math.abs(expected) * 2 ** -50),
      `${phase}/${period} => ${radians}: ${actual} versus ${expected}`,
    );
    // An ordinary visible-row displacement retains its final native truncate-and-shift value.
    assert.equal(Math.trunc(actual * (1920 * 7)) >> 1, Math.trunc(expected * (1920 * 7)) >> 1);
  }
  assert.deepEqual(
    [...exponents].sort((a, b) => a - b),
    Array.from({length: 16}, (_, index) => index + 18),
  );
  assert.ok(inputs.size > 19000);
});
