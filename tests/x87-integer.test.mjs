import test from 'node:test';
import assert from 'node:assert/strict';
import {x87TrigonometricInteger, X87IntegerUncertainty} from '../dist/core/x87-integer.js';

test('x87 integer observation preserves rounded periods, conversion and unresolved CPU boundaries', () => {
  const factor = 2.663161090079238e-7;
  const angle = (operation, degrees) =>
    x87TrigonometricInteger(operation, degrees * 65536 * factor, 65536);
  assert.deepEqual(
    [
      angle('sin', 0),
      angle('cos', 0),
      angle('sin', 30),
      angle('cos', 60),
      angle('sin', 90),
      angle('sin', 270),
      angle('cos', 180),
    ],
    [0, 65536, 32767, 32768, 65536, -65536, -65536],
  );
  assert.equal(x87TrigonometricInteger('atan', 1, 3754936.206169363), 45 * 65536);
  assert.equal(x87TrigonometricInteger('atan', -1, 3754936.206169363), -45 * 65536);
  // The x87 rounded-period function differs materially from mathematical sin.
  assert.equal(x87TrigonometricInteger('sin', 2 ** 62, 65536), -46342);
  // FISTP stores signed64; BP observes its lowDWORD rather than int32 saturation.
  assert.equal(x87TrigonometricInteger('cos', 0, 0x1_0000_0001), 1);
  assert.equal(x87TrigonometricInteger('cos', 0, -0x1_0000_0001), -1);
  assert.equal(x87TrigonometricInteger('atan', 2, 9e18), 0);
  assert.throws(() => x87TrigonometricInteger('atan', 0.003, 1e18), X87IntegerUncertainty);
});
