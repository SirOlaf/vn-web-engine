import test from 'node:test';
import assert from 'node:assert/strict';
import {
  burikoSystemTimeToFileTime,
  burikoFileTimeToSystemTime,
  writeBurikoSystemTime,
} from '../dist/engines/buriko/native/file-time.js';
function systemTime(fields) {
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  fields.forEach((field, index) => view.setUint16(index * 2, field, true));
  return {bytes, offset: 0};
}
test('UTC file-time conversion retains known epochs, Gregorian leap days and independent weekday calculation', () => {
  assert.equal(burikoSystemTimeToFileTime(systemTime([1601, 1, 6, 1, 0, 0, 0, 0])), 0n);
  assert.deepEqual([...burikoFileTimeToSystemTime(0n)], [1601, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal(
    burikoSystemTimeToFileTime(systemTime([1970, 1, 0, 1, 0, 0, 0, 0])),
    116444736000000000n,
  );
  for (const fields of [
    [2000, 2, 0, 29, 12, 34, 56, 789],
    [2026, 9, 0, 13, 3, 4, 5, 123],
    [2400, 2, 0, 29, 23, 59, 59, 999],
  ]) {
    const value = burikoSystemTimeToFileTime(systemTime(fields)),
      expected =
        BigInt(
          Date.UTC(fields[0], fields[1] - 1, fields[3], fields[4], fields[5], fields[6], fields[7]),
        ) *
          10000n +
        116444736000000000n;
    assert.equal(value, expected);
    const output = {bytes: new Uint8Array(20), offset: 2};
    assert.equal(writeBurikoSystemTime(output, value + 9999n), true);
    const actual = Array.from({length: 8}, (_, index) =>
      new DataView(output.bytes.buffer).getUint16(index * 2 + 2, true),
    );
    const expectedFields = [...fields];
    expectedFields[2] = new Date(Number((value - 116444736000000000n) / 10000n)).getUTCDay();
    assert.deepEqual(actual, expectedFields);
  }
});
