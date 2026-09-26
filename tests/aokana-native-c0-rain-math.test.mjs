import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRainSineCosine} from '../dist/engines/buriko/bp/opcodes/native-math.js';

import {referenceSineCosine} from './aokana-trig-reference.mjs';

test('rain CRT reduction covers signed DWORD tenths-degree edges and the large-reducer boundary', () => {
  const inputs = new Set([0, 1, -1, 0x7fffffff, -0x80000000]);
  const addNeighborhood = (center) => {
    for (let delta = -4; delta <= 4; delta++) {
      const value = center + delta;
      if (value >= -0x80000000 && value <= 0x7fffffff) inputs.add(value);
    }
  };
  for (let exponent = 0; exponent <= 31; exponent++) {
    addNeighborhood(2 ** exponent);
    addNeighborhood(-(2 ** exponent));
  }
  for (const radians of [Math.PI / 4, 500000, 2 ** 19, 2 ** 20, 2 ** 21]) {
    const center = Math.round((radians * 10) / 0.017453292519444445);
    addNeighborhood(center);
    addNeighborhood(-center);
  }
  // Near quadrant boundaries over each reducer exponent and all four quadrants.
  for (const center of [0, 2 ** 18, 2 ** 19, 2 ** 20, 2 ** 21, 3748066]) {
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const radians = ((Math.round(center / (Math.PI / 2)) + quadrant) * Math.PI) / 2;
      const tenths = Math.round((radians * 10) / 0.017453292519444445);
      addNeighborhood(tenths);
      addNeighborhood(-tenths);
    }
  }
  // Uniform signed DWORD samples, separate from the runtime CRT PRNG.
  let word = 0x62d4ae31;
  for (let i = 0; i < 20000; i++) {
    word ^= word << 13;
    word ^= word >>> 17;
    word ^= word << 5;
    inputs.add(word | 0);
  }
  for (const input of inputs) {
    const actual = nativeRainSineCosine(input),
      expected = referenceSineCosine(((input | 0) * 0.017453292519444445) / 10);
    for (const component of ['sine', 'cosine']) {
      const error = Math.abs(actual[component] - expected[component]);
      assert.ok(
        error <= Math.max(1e-30, Math.abs(expected[component]) * 2 ** -50),
        `${input} ${component}: actual ${actual[component]}, reference ${expected[component]}`,
      );
      assert.equal(
        Math.trunc(actual[component] * 256),
        Math.trunc(expected[component] * 256),
        `${input} native signed rotation coefficient ${component}`,
      );
    }
  }
  assert.ok(inputs.size > 20500);
});
