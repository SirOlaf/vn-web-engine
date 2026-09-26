import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeEasingPower} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-easing-power.js';
import {nativeDisplayEasing} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-math.js';
import {
  referencePower,
  referenceEasing,
  referenceCvtt,
} from './helpers/aokana-sse2-power-reference.mjs';

const exponents = [2, 2.5, 3, 4, 5, 6];
const one = 0x1000000;
const exhaustive = process.env.AOKANA_EASING_EXHAUSTIVE === '1';

function same(actual, expected, context) {
  if (!Object.is(actual, expected)) assert.equal(actual, expected, context());
}

// One arithmetic-system gate. The expensive ordinary-domain pass is opt-in;
// shard bounds are inclusive and only affect that pass, not boundary coverage.
test('easing SSE2 system: exact kernel, selectors, indices and CVTT boundaries', () => {
  const bases = new Set([0, 1, -1, -2147483648, 2147483647]);
  const add = (value) => {
    if (value >= -2147483648 && value <= 2147483647) bases.add(value);
  };
  for (const center of [one, one - 2147483647, one - 2147483648])
    for (let delta = -3; delta <= 3; delta++) add(center + delta);
  for (let bit = 0; bit <= 31; bit++)
    for (let delta = -2; delta <= 2; delta++) {
      add(2 ** bit + delta);
      add(-(2 ** bit) + delta);
    }
  // Table centers and each rounding boundary, at several integer magnitudes.
  for (const bit of [9, 16, 24, 30])
    for (let index = 0; index <= 256; index++)
      for (const offset of [0, -0.5, 0.5])
        for (const delta of [-1, 0, 1]) {
          const value = Math.floor(2 ** bit * (1 + (index + offset) / 256)) + delta;
          add(value);
          add(-value);
        }
  let random = 0x56_92_00;
  for (let i = 0; i < 4096; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) | 0;
    add(random);
  }

  for (let family = 0; family < exponents.length; family++) {
    const exponent = exponents[family];
    const selector = 4 + family * 2;
    const coverage = {log: new Set(), exp: new Set()};
    const denominator = referencePower(one, exponent);
    const cases = new Set(bases);
    // Locate final-CVTT transition neighbors using reference bisection, including
    // first int32-indefinite value, and ordinary integer output transitions.
    for (const target of [1, 2, 3, 255, 256, 257, 32767, 32768, 65535, 65536, 2147483648]) {
      let low = 0,
        high = 2147483647;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const output = (referencePower(middle, exponent) * 65536) / denominator;
        if (output >= target) high = middle;
        else low = middle + 1;
      }
      for (let delta = -3; delta <= 3; delta++) {
        const value = low + delta;
        if (value >= 0 && value <= 2147483647) {
          cases.add(value);
          cases.add(-value);
          cases.add((one - value) | 0);
        }
      }
    }
    for (const base of cases) {
      same(
        nativeEasingPower(base, exponent),
        referencePower(base, exponent, coverage),
        () => `power(${base},${exponent})`,
      );
      for (const mode of [selector, selector + 1])
        same(
          nativeDisplayEasing(base, mode),
          referenceEasing(base, mode),
          () => `easing(${base},${mode})`,
        );
    }
    assert.equal(coverage.log.size, 257, `all log indices, exponent ${exponent}`);
    assert.equal(coverage.exp.size, 64, `all exp indices, exponent ${exponent}`);
  }

  if (exhaustive) {
    const first = Number(process.env.AOKANA_EASING_FIRST ?? 0);
    const last = Number(process.env.AOKANA_EASING_LAST ?? one);
    assert.ok(
      Number.isInteger(first) &&
        Number.isInteger(last) &&
        first >= 0 &&
        last <= one &&
        first <= last,
    );
    for (let family = 0; family < exponents.length; family++) {
      const exponent = exponents[family];
      const denominator = referencePower(one, exponent);
      const selector = 4 + family * 2;
      for (let base = first; base <= last; base++) {
        const power = referencePower(base, exponent);
        same(
          nativeEasingPower(base, exponent),
          power,
          () => `exhaustive power(${base},${exponent})`,
        );
        same(
          nativeDisplayEasing(base, selector),
          referenceCvtt((power * 65536) / denominator),
          () => `exhaustive easing(${base},${selector})`,
        );
        // This bijection covers every ordinary progress for the reverse selector.
        same(
          nativeDisplayEasing(one - base, selector + 1),
          referenceCvtt((1 - power / denominator) * 65536),
          () => `exhaustive easing(${one - base},${selector + 1})`,
        );
      }
      process.stderr.write(`easing sweep ${first}..${last}: exponent ${exponent} complete\n`);
    }
  }
});
