import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  aokanaRosettaSseReciprocal,
  aokanaRosettaSseReciprocalSqrt,
} from '../dist/engines/buriko/games/aokana/native/cpu-numerical-profile.js';

const bits = new DataView(new ArrayBuffer(4));
function number(value) {
  bits.setUint32(0, value, true);
  return bits.getFloat32(0, true);
}
function encoding(value) {
  bits.setFloat32(0, value, true);
  return bits.getUint32(0, true);
}

// These SHA-256 values were computed from the native instruction's measured output
// bins, not from the implementation. No executable data or lookup file is needed.
test('reciprocal seeds match all 2048 measured bins and signed exponent scaling', () => {
  const outputs = new Uint8Array(2048 * 4),
    view = new DataView(outputs.buffer);
  for (let i = 0; i < 2048; i++) {
    const input = 0x3f800000 + i * 4096;
    const expected = aokanaRosettaSseReciprocal(number(input));
    view.setFloat32(i * 4, expected, true);
    assert.equal(aokanaRosettaSseReciprocal(number(input + 4095)), expected);
    for (const exponent of [-32, -17, -16, -1, 0, 15, 16, 31, 32, 33]) {
      const scaledInput = number(input + exponent * 0x800000);
      const scaled = number(encoding(expected) - exponent * 0x800000);
      assert.equal(aokanaRosettaSseReciprocal(scaledInput), scaled);
      if (exponent >= -16 && exponent <= 15)
        assert.equal(aokanaRosettaSseReciprocal(-scaledInput), -scaled);
    }
  }
  assert.equal(
    createHash('sha256').update(outputs).digest('hex'),
    '3e4839b6695443c06077b9165031436ef87546e10fa9eb2ff13366de34a19c04',
  );
});

test('reciprocal-square-root seeds match every measured parity bin and exponent endpoints', () => {
  const hashes = [
    'dd6a2f4142f45676c823f5a37ac2dfb201bf5719c2282acc092a87f379c4e3a9',
    '2ae5836cb7ca6b49e51c46a764cd709e029a0fb6e59a88f6ac0f1dfb07bf822b',
  ];
  for (let parity = 0; parity < 2; parity++) {
    const outputs = new Uint8Array(1024 * 4),
      view = new DataView(outputs.buffer);
    for (let i = 0; i < 1024; i++) {
      const input = 0x3f800000 + parity * 0x800000 + i * 8192;
      const expected = aokanaRosettaSseReciprocalSqrt(number(input));
      view.setFloat32(i * 4, expected, true);
      assert.equal(aokanaRosettaSseReciprocalSqrt(number(input + 8191)), expected);
      for (const exponent of [-32 + parity, -2 + parity, 30 + parity, 32 + parity]) {
        const scaledInput = number(input + (exponent - parity) * 0x800000);
        const scaled = number(encoding(expected) - ((exponent - parity) / 2) * 0x800000);
        assert.equal(aokanaRosettaSseReciprocalSqrt(scaledInput), scaled);
      }
    }
    assert.equal(createHash('sha256').update(outputs).digest('hex'), hashes[parity]);
  }
});
