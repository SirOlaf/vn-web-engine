import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAokanaRecordPredicateFormat,
  matchesAokanaRecordPredicate,
  findAokanaMatchingRecord,
  writeAokanaMatchingRecordIndices,
} from '../dist/engines/buriko/games/aokana/native/record-search.js';
import {createGroup81RecordSearch} from '../dist/engines/buriko/games/aokana/native/group-81-record-search.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const pointer = (...bytes) => ({bytes: Uint8Array.of(...bytes), offset: 0});
function words(values) {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return {bytes, offset: 0};
}
function readWords(pointer, count) {
  const view = new DataView(pointer.bytes.buffer, pointer.bytes.byteOffset + pointer.offset);
  return Array.from({length: count}, (_, index) => view.getUint32(index * 4, true));
}

test('typed predicates retain native byte widths, one-sided signed extension and scalar-only nonzero flag', () => {
  for (const [tag, size] of [
    [0, 1],
    [1, 2],
    [2, 4],
    [3, 8],
    [4, 1],
    [5, 2],
    [6, 4],
    [9, 2],
    [0xfffe, 4],
  ])
    assert.deepEqual(decodeAokanaRecordPredicateFormat(0x12340000 | tag), {
      result: 0,
      size,
      tag: tag === 0xfffe ? -2 : tag,
    });
  assert.deepEqual(decodeAokanaRecordPredicateFormat(0x0003ffff), {result: 0, size: 3, tag: -1});
  for (const [unsignedTag, signedTag, size] of [
    [0, 4, 1],
    [1, 5, 2],
    [2, 6, 4],
  ]) {
    const a = pointer(...Array(size).fill(255)),
      b = pointer(...Array(size - 1).fill(0), 128);
    assert.deepEqual(
      Array.from({length: 8}, (_, operation) =>
        matchesAokanaRecordPredicate(a, b, unsignedTag, operation, 0),
      ),
      [false, true, false, true, false, false, true, true],
    );
    // -1 is compared with positive128/32768/2147483648, not a sign-extended comparison value.
    assert.deepEqual(
      Array.from({length: 8}, (_, operation) =>
        matchesAokanaRecordPredicate(a, b, signedTag, operation, 0),
      ),
      [false, true, false, true, true, true, false, false],
    );
  }
  const zero = words([0]);
  assert.equal(matchesAokanaRecordPredicate(zero, zero, 2, 0, 0), true);
  assert.equal(matchesAokanaRecordPredicate(zero, zero, 2, 0, 1), false);
  assert.equal(matchesAokanaRecordPredicate(zero, zero, 0x0004ffff, 0, 1), true);
  const fullQword = pointer(1, 2, 3, 4, 5, 6, 7, 128);
  assert.equal(matchesAokanaRecordPredicate(fullQword, fullQword, 3, 0, 0), true);
  assert.equal(matchesAokanaRecordPredicate(fullQword, fullQword, 3, 3, 0), true);
  assert.equal(matchesAokanaRecordPredicate(pointer(2, 0), pointer(3, 0), 9, 4, 0), false);
  const rawA = pointer(1, 2, 4),
    rawB = pointer(8, 16, 32);
  assert.equal(matchesAokanaRecordPredicate(rawA, rawB, 0x0003ffff, 2, 1), true);
  rawB.bytes[2] = 4;
  assert.equal(matchesAokanaRecordPredicate(rawA, rawB, 0x0003ffff, 3, 1), true);
});

test('matching-index enumeration observes preceding normal writes to comparison and source spans', () => {
  const comparisonAndOutput = words([5, 99, 99, 99]),
    source = words([5, 0, 1, 5]);
  assert.equal(
    writeAokanaMatchingRecordIndices(comparisonAndOutput, source, 4, 4, comparisonAndOutput, 2, 0),
    2,
  );
  assert.deepEqual(readWords(comparisonAndOutput, 2), [0, 1]);
  const liveSource = words([5, 5, 5, 5]),
    output = {bytes: liveSource.bytes, offset: 4};
  assert.equal(writeAokanaMatchingRecordIndices(output, liveSource, 4, 4, words([5]), 2, 0), 3);
  assert.deepEqual(readWords(output, 3), [0, 2, 3]);
  const padded = words([10, 999, 30, 999, 20, 999]);
  assert.equal(findAokanaMatchingRecord(padded, 3, 8, words([25]), 2, 6), 1);
});

test('both record-search wrappers preserve source/output/comparison resolution and result order', () => {
  const memory = new AokanaBpMemory(new Uint8Array()),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 24,
      moduleCapacity: 512,
      frameCapacity: 0,
    }),
    slots = createGroup81RecordSearch(),
    input = 0x10000020,
    comparison = 0x10000090,
    output = 0x100000c0;
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x81][slot.secondary]);
  [7, 3, 7, 5].forEach((value, index) => memory.writeU32(thread, input + index * 8, value));
  memory.writeU32(thread, comparison, 3);
  const resolve = memory.resolve.bind(memory),
    observations = [];
  memory.resolve = (active, address) => {
    observations.push(address);
    return resolve(active, address);
  };
  const call = (secondary, args) => {
    observations.length = 0;
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute({thread, memory}), 0);
    return pop32(thread);
  };
  assert.equal(call(0xb8, [input, 4, 8, 7, 2, 0]), 0);
  assert.deepEqual(observations, [input]);
  assert.equal(call(0xb9, [output, input, 4, 8, comparison, 0x0004ffff, 0]), 1);
  assert.deepEqual(observations, [input, output, comparison]);
  assert.equal(memory.readU32(thread, output), 1);
  assert.equal(call(0xb9, [output, input, 4, 8, 7, 2, 0]), 2);
  assert.deepEqual(observations, [input, output]);
  assert.equal(memory.readU32(thread, output), 0);
  assert.equal(memory.readU32(thread, output + 4), 2);
  assert.equal(thread.stackIndex, 0);
});
