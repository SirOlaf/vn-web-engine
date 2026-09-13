import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAffineSineCosine} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-math.js';

test('affine trigonometry evaluates each independently rounded angle over the signed DWORD input domain', () => {
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
  for (let index = 0; index < 128; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    inputs.push(value);
  }
  for (const input of inputs) {
    const angle = -(((input | 0) * Math.PI) / 11796480),
      perpendicular = angle + Math.PI / 2,
      actual = nativeAffineSineCosine(input);
    for (const [key, expected] of [
      ['sine', Math.sin(angle)],
      ['cosine', Math.cos(angle)],
      ['perpendicularSine', Math.sin(perpendicular)],
      ['perpendicularCosine', Math.cos(perpendicular)],
    ])
      assert.ok(Math.abs(actual[key] - expected) <= 8e-16, `${input | 0} ${key}`);
  }
  assert.equal(Object.is(nativeAffineSineCosine(0).sine, -0), true);
});
