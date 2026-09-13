import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeMeshSineCosine} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-math.js';
import {referenceSineCosine} from './aokana-trig-reference.mjs';

test('mesh angles preserve signed DWORD negation before conversion and share one rounded radian angle', () => {
  const inputs = [
    0,
    1,
    -1,
    65536,
    45 * 65536,
    90 * 65536,
    180 * 65536,
    360 * 65536,
    -360 * 65536,
    0x7fffffff,
    0x7ffffffe,
    -0x80000000,
    -0x7fffffff,
    0x55555555,
    0xaaaaaaaa,
  ];
  let value = 0x13579bdf;
  for (let index = 0; index < 512; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    inputs.push(value);
  }
  for (const input of inputs)
    for (const negate of [false, true]) {
      const signed = negate ? -input | 0 : input | 0;
      const radians = (signed * 3.141592653589793) / 11796480;
      const expected = referenceSineCosine(radians);
      const actual = nativeMeshSineCosine(input, negate);
      for (const key of ['sine', 'cosine']) {
        assert.ok(
          Math.abs(actual[key] - expected[key]) <= 8e-16,
          `${input | 0}, negate=${negate}, ${key}`,
        );
      }
    }
  assert.equal(Object.is(nativeMeshSineCosine(0, true).sine, 0), true);
  assert.deepEqual(
    nativeMeshSineCosine(-0x80000000, true),
    nativeMeshSineCosine(-0x80000000, false),
  );
});
