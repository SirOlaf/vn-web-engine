import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAokanaCrtWideInteger as integer,
  parseAokanaCrtWideFloat as float,
  parseAokanaPropertyNumber as property,
  aokanaCrtWideSpace,
} from '../dist/engines/buriko/games/aokana/native/crt-numbers.js';

test('linked CRT integer parsing keeps Unicode digit blocks and consumes overflow tails', () => {
  assert.deepEqual(integer('  -2147483649rest', 10, true), {
    value: 0x80000000,
    end: 13,
    rangeError: true,
  });
  assert.deepEqual(integer('+4294967296zzz', 10, false), {
    value: 0xffffffff,
    end: 11,
    rangeError: true,
  });
  assert.deepEqual(integer('-4294967295', 10, false), {value: 1, end: 11, rangeError: false});
  assert.deepEqual(integer('０xＦＦ', 16, false), {value: 0, end: 0, rangeError: false});
  assert.deepEqual(integer('０xF９tail', 16, false), {value: 249, end: 4, rangeError: false});
  assert.equal(integer('१२३', 10, true).value, 123);
  assert.equal(integer('௧', 10, true).end, 0); // Tamil digits are absent from the executable's table.
  assert.equal(integer('0x', 16, false).end, 0);
});

test('wide whitespace follows the verified static table and declared modern Win32 profile', () => {
  for (const character of [
    9, 13, 32, 133, 160, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ])
    assert.equal(aokanaCrtWideSpace(character), true);
  for (const character of [0x180e, 0x200b, 0xfeff, 0xffff])
    assert.equal(aokanaCrtWideSpace(character), false);
  assert.equal(integer('\u0085\u3000７', 10, true).value, 7);
});

test('floating grammar retains rollback and sequential NaN matcher cursor mutations', () => {
  assert.equal(float('-0x.').end, 2);
  assert.equal(float('-0x.').bits, 0x8000000000000000n);
  assert.equal(float('1e+tail').end, 1);
  assert.equal(float('infinity!').end, 8);
  assert.equal(float('infinite').end, 3);
  assert.equal(float('NAN(no close').end, 3);
  assert.equal(float('NAN(SNAN)').bits, 0x7ff0000000000001n);
  assert.equal(float('NAN(SIND)').bits, 0xfff8000000000000n);
  assert.equal(float('NAN(SNANfoo)').end, 12);
  assert.equal(float('NAN(SNANfoo)').bits, 0x7fffffffffffffffn);
  assert.equal(float('０x1').end, 1);
});

test('binary64 conversion retains nearest/even ties, subnormals and signed zero', () => {
  assert.equal(
    float('1.00000000000000011102230246251565404236316680908203125').bits,
    0x3ff0000000000000n,
  );
  assert.equal(
    float('1.00000000000000033306690738754696212708950042724609375').bits,
    0x3ff0000000000002n,
  );
  assert.equal(float('0x1p-1074').bits, 1n);
  assert.equal(float('0x1p-1075').bits, 0n);
  assert.equal(float('0x1.0000000000001p-1075').bits, 1n);
  assert.equal(float('-0e999999').bits, 0x8000000000000000n);
  assert.equal(float('0x1.fffffffffffffp1023').bits, 0x7fefffffffffffffn);
  assert.equal(float('0x1.fffffffffffff8p1023').bits, 0x7ff0000000000000n);
  assert.equal(float('１２.５e１').value, 125);
});

test('native mantissa capacity and early exponent gates remain observable', () => {
  assert.equal(float('０'.repeat(768) + '1').bits, 0n);
  assert.equal(float('0.' + '0'.repeat(5200) + '1e5201').bits, 0x7ff0000000000000n);
  assert.equal(float('0.' + '0'.repeat(5200) + '1e5200').value, 0.1);
});

test('property numeric conversion accepts trailing text and follows snap-floor-CVTTSD2SI order', () => {
  assert.deepEqual(property(0, '12tail'), {result: 0, value: 12});
  assert.deepEqual(property(3, 'junk'), {result: 0x80000008});
  assert.deepEqual(property(3, '0.5tail'), {result: 0, value: 32768});
  assert.deepEqual(property(3, '-0.000001'), {result: 0, value: -1});
  assert.deepEqual(property(3, '-0.0000000001'), {result: 0, value: 0});
  assert.deepEqual(property(3, 'inf'), {result: 0, value: -2147483648});
  assert.deepEqual(property(3, 'nan'), {result: 0, value: -2147483648});
});
