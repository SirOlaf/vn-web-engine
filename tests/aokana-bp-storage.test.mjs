import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoBpThread,
  BurikoBpSharedThread,
  push32,
  pop32,
  setPc,
  readFrame32,
  writeFrame32,
  validCodeAddress,
  validFrameAddress,
  reserveThreadRegions,
  releaseThreadRegions,
} from '../dist/engines/buriko/bp/state.js';
import * as decode from '../dist/engines/buriko/bp/decode.js';
import {BurikoBpMemory, BurikoBpHeap, pointerView} from '../dist/engines/buriko/bp/memory.js';
import {attachModule, detachLastModule} from '../dist/engines/buriko/bp/modules.js';

const thread = (options = {}) =>
  new BurikoBpThread({
    id: 1,
    operandCapacity: 3,
    moduleCapacity: 128,
    frameCapacity: 128,
    ...options,
  });
function moduleBytes(payload, offset = 16) {
  const bytes = new Uint8Array(offset + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, offset, true);
  view.setUint32(4, payload.length, true);
  bytes.set(payload, offset);
  return bytes;
}

test('Buriko operand stack wraps with retained cells and separate frame storage', () => {
  const t = thread();
  push32(t, 11);
  push32(t, -1);
  push32(t, 33);
  push32(t, 44);
  assert.equal(t.stackIndex, 1);
  assert.deepEqual([pop32(t), pop32(t), pop32(t), pop32(t)], [44, 33, 0xffffffff, 44]);
  writeFrame32(t, 3, 0x78563412);
  assert.equal(readFrame32(t, 3), 0x78563412);
  assert.deepEqual(Array.from(t.frameMemory.subarray(3, 7)), [0x12, 0x34, 0x56, 0x78]);
  assert.throws(() => push32(thread({operandCapacity: 0}), 0));
});

test('Buriko immediate readers preserve instruction start and consume exact widths', () => {
  const t = thread();
  t.moduleMemory.set([0xaa, 0x80, 0x00, 0x80, 0xef, 0xcd, 0xab, 0x89, 1, 2, 3, 4, 5, 6, 7, 0x80]);
  assert.equal(decode.fetchOpcode(t), 0xaa);
  assert.equal(decode.readI8(t), -128);
  assert.equal(decode.readI16(t), -32768);
  assert.equal(decode.readU32(t), 0x89abcdef);
  assert.equal(decode.readI64(t), BigInt.asIntN(64, 0x8007060504030201n));
  assert.equal(t.pc, 16);
  assert.equal(t.instructionStart, 0);
  setPc(t, 5);
  assert.equal(t.pc, 5);
  assert.equal(t.instructionStart, 5);
});

test('Buriko signed and typed varints retain x64 shift behavior, including overlong encodings', () => {
  const t = thread();
  for (const [bytes, value] of [
    [[0x7f], -1],
    [[0xc0, 0], 64],
    [[0xbf, 0x7f], -65],
    [[0xff, 0xff, 0xff, 0xff, 7], 0x7fffffff],
    [[0x80, 0x80, 0x80, 0x80, 0x78], -0x80000000],
    [[...Array(9).fill(0x80), 0x40], -64],
  ]) {
    t.pc = 0;
    t.moduleMemory.set(bytes);
    assert.equal(decode.readVarInt(t), value);
    assert.equal(t.pc, bytes.length);
  }
  for (const [bytes, expected] of [
    [[0x3f], {type: 3, value: 15}],
    [[0x43], {type: 3, value: -16}],
    [[0xc3, 0], {type: 3, value: 16}],
    [[0xbf, 0x7f], {type: 3, value: -17}],
  ]) {
    t.pc = 0;
    t.moduleMemory.set(bytes);
    assert.deepEqual(decode.readTypedVarInt(t), expected);
    assert.equal(t.pc, bytes.length);
  }
  t.moduleMemory = Uint8Array.of(0x80);
  t.pc = 0;
  assert.throws(() => decode.readVarInt(t));
  assert.equal(t.pc, 0);
});

test('Buriko module attachment retains raw names, ordered bases, and detached payload bytes', () => {
  const t = thread({moduleCapacity: 5});
  const name = Uint8Array.of(0x81, 0xff, 0, 66);
  assert.equal(attachModule(t, name, moduleBytes([1, 2], 8)), 0);
  name[0] = 0;
  assert.deepEqual(t.modules[0].name, Uint8Array.of(0x81, 0xff));
  assert.equal(attachModule(t, 'b', moduleBytes([3, 4, 5])), 2);
  assert.equal(attachModule(t, 'c', moduleBytes([6])), 0x80000000);
  assert.equal(detachLastModule(t), 1);
  assert.equal(t.moduleSize, 2);
  assert.deepEqual(t.moduleMemory, Uint8Array.of(1, 2, 3, 4, 5));
  assert.equal(attachModule(t, 'd', moduleBytes([9])), 2);
  assert.deepEqual(t.moduleMemory, Uint8Array.of(1, 2, 9, 4, 5));
  assert.equal(detachLastModule(t), 1);
  assert.equal(detachLastModule(t), 0);
  assert.equal(detachLastModule(t), 0x80000001);
  assert.equal(validCodeAddress(t, 4), true);
  assert.equal(validCodeAddress(t, 5), false);
});

test('Buriko tagged memory preserves byte overlap in global/module/frame/heap banks', () => {
  const t = thread();
  const m = new BurikoBpMemory(new Uint8Array(64));
  t.heap.allocate(32);
  for (const address of [1, 0x10000001, 0x20000001, 0x30000001]) {
    m.writeU64(t, address, 0x8070605040302010n);
    assert.equal(m.readU32(t, address + 1), 0x50403020);
    m.writeU16(t, address + 2, 0x1234);
    assert.equal(m.readI8(t, address + 7), -128);
    assert.equal(m.readU32(t, address), 0x12342010);
  }
  assert.equal(m.resolve(t, 0), null);
  assert.throws(() => m.readU8(t, 0), /Null memory/);
  assert.throws(() => m.readU32(t, 0x1000007f), /outside backing/);
  m.copy(t, 0x10000002, 0x10000001, 7);
  assert.deepEqual(
    t.moduleMemory.subarray(1, 9),
    Uint8Array.of(0x10, 0x10, 0x20, 0x34, 0x12, 0x50, 0x60, 0x70),
  );
  assert.throws(() => pointerView({bytes: new Uint8Array(8).subarray(0, 2), offset: 1}, 2));
});

test('Buriko pooled addresses select every bank and forbid freeing interior addresses', () => {
  const t = thread();
  const m = new BurikoBpMemory(new Uint8Array(1));
  const cases = [
    [4, 0, 0],
    [5, 1, 0],
    [6, 2, 0],
    [7, 3, 0],
    [8, 4, 0],
    [9, 4, 4],
    [10, 4, 8],
    [11, 4, 12],
    [12, 5, 0],
    [13, 5, 1],
    [14, 5, 2],
    [15, 5, 3],
  ];
  for (const [bank, group, slot] of cases) {
    const bytes = Uint8Array.of(bank, 0x33, 0x44);
    m.pools[group][slot] = {bytes, offset: 0};
    const address = (bank * 0x10000000) >>> 0;
    assert.equal(m.readU8(t, address), bank);
    assert.equal(m.readU16(t, address + 1), 0x4433);
    assert.equal(m.freePooled(address + 1), false);
    assert.equal(m.freePooled(address), true);
    assert.throws(() => m.resolve(t, address), /Unresolved pooled/);
  }
  assert.equal(m.allocatePooled(0x1001), 0x50000000);
  assert.equal(m.allocatePooled(1), 0x40000000);
  assert.equal(m.allocatePooled(1), 0x40001000);
  assert.equal(m.freePooled(0x40000000), true);
  assert.equal(m.allocatePooled(1), 0x40000000);
  assert.equal(m.allocatePooled(0x10000001), 0);
});

test('Buriko heap first-fit, growth, free coalescing, and address reuse preserve contents', () => {
  const heap = new BurikoBpHeap();
  assert.equal(heap.allocate(7), 0);
  assert.equal(heap.allocate(9), 7);
  assert.equal(heap.allocate(0x8000 - 16), 16);
  heap.bytes.set([11, 22, 33], 7);
  assert.equal(heap.allocate(1), 0x8000);
  assert.equal(heap.bytes.length, 0x10000);
  assert.deepEqual(heap.bytes.subarray(7, 10), Uint8Array.of(11, 22, 33));
  assert.equal(heap.free(7), true);
  assert.equal(heap.free(0), true);
  assert.equal(heap.free(7), false);
  assert.equal(heap.free(8), false);
  assert.equal(heap.allocate(16), 0);
  const zero = heap.allocate(0);
  assert.equal(heap.allocate(0), zero);
  assert.equal(heap.free(zero), true);
  assert.equal(heap.free(zero), true);
});

test('Buriko indirect buffers retain handle identity across resize and insertion', () => {
  const t = thread();
  const m = new BurikoBpMemory(new Uint8Array(1));
  const {result, address} = m.createBuffer(4);
  assert.equal(result, 0);
  assert.equal(address, 0x0fff001f);
  assert.equal(m.writeBuffer(address, 0, {bytes: Uint8Array.of(1, 2, 3, 4), offset: 0}, 4), 0);
  assert.equal(m.resolve(t, address + 0x700).bytes, m.resolve(t, address).bytes);
  assert.equal(m.resizeBuffer(address, 6), 0);
  assert.deepEqual(m.resolve(t, address).bytes.subarray(0, 4), Uint8Array.of(1, 2, 3, 4));
  assert.equal(m.insertBuffer(address, 2, {bytes: Uint8Array.of(8, 9), offset: 0}, 2), 0);
  assert.deepEqual(m.resolve(t, address).bytes.subarray(0, 6), Uint8Array.of(1, 2, 8, 9, 3, 4));
  assert.equal(m.bufferSize(address).size, 8);
  assert.equal(m.readBuffer(address, 8, {bytes: new Uint8Array(), offset: 0}, 0), 0x80000010);
  assert.equal(m.readBuffer(address, 7, {bytes: new Uint8Array(2), offset: 0}, 2), 0x80000008);
  assert.equal(m.freeIndirect(address, 1), 0x80000009);
  assert.equal(m.freeIndirect(address, 0), 0);
  assert.equal(m.resolve(t, address), null);
  assert.equal(m.freeIndirect(address, 0), 0x80000009);
  assert.equal(m.resolve(t, 0x0fff2000), null);
  const empty = m.createBuffer(0);
  assert.equal(m.bufferSize(empty.address).size, 0);
  assert.equal(m.resolve(t, empty.address), null);
  assert.equal(m.freeIndirect(empty.address, 0), 0);
});

test('Buriko indirect slot stepping visits all 256 slots and string storage retains raw bytes', () => {
  const t = thread();
  const m = new BurikoBpMemory(new Uint8Array(1));
  const addresses = Array.from({length: 256}, () => m.createBuffer(0).address);
  assert.equal(new Set(addresses).size, 256);
  assert.equal(addresses.at(-1), 0x0fff0000);
  assert.equal(m.createBuffer(0).result, 0x80000005);
  assert.equal(m.freeIndirect(addresses[77], 0), 0);
  assert.equal(m.createBuffer(0).address, addresses[77]);
  const s = m.createString(Uint8Array.of(0x81, 0xff, 0, 9));
  assert.equal(s.address, 0x0fff101f);
  assert.deepEqual(m.readCString(t, s.address), Uint8Array.of(0x81, 0xff));
  assert.equal(m.insertStringBytes(s.address, -1, Uint8Array.of(0x40)), 0);
  assert.deepEqual(m.readCString(t, s.address), Uint8Array.of(0x81, 0xff, 0x40));
  assert.equal(m.clearString(s.address), 0);
  assert.equal(m.readCString(t, s.address).length, 0);
});

test('Buriko paired reservations reuse gaps but release retains reduced usable capacities', () => {
  const owner = thread({moduleCapacity: 100, frameCapacity: 80});
  const first = thread({id: 2}),
    second = thread({id: 3}),
    third = thread({id: 4});
  assert.deepEqual(reserveThreadRegions(owner, first, 20, 10), {
    result: 0,
    moduleOffset: 80,
    frameOffset: 70,
  });
  assert.deepEqual(reserveThreadRegions(owner, second, 30, 20), {
    result: 0,
    moduleOffset: 50,
    frameOffset: 50,
  });
  assert.equal(owner.retentionCount, 2);
  assert.equal(releaseThreadRegions(owner, first), true);
  assert.equal(owner.moduleUsableCapacity, 50);
  assert.deepEqual(reserveThreadRegions(owner, third, 10, 10), {
    result: 0,
    moduleOffset: 90,
    frameOffset: 70,
  });
  assert.equal(owner.moduleUsableCapacity, 50);
  assert.equal(releaseThreadRegions(owner, first), false);
  owner.moduleSize = 49;
  assert.equal(reserveThreadRegions(owner, first, 60, 1).result, 0x80000002);
});

test('Buriko child threads share bases, forward allocation and validation, and release before disposal', () => {
  const owner = thread({moduleCapacity: 100, frameCapacity: 80});
  const child = new BurikoBpSharedThread({id: 2, operandCapacity: 2});
  const appended = [];
  assert.equal(
    child.initialize(owner, 20, 10, 7, (t) => appended.push(t)),
    0,
  );
  assert.equal(child.moduleFloor, 80);
  assert.equal(child.moduleSize, 80);
  assert.equal(child.frameFloor, 70);
  assert.equal(child.frameCursor, 70);
  assert.equal(child.pc, 7);
  assert.equal(child.moduleMemory, owner.moduleMemory);
  assert.equal(child.frameMemory, owner.frameMemory);
  assert.equal(child.heap, owner.heap);
  assert.equal(validCodeAddress(child, 99), true);
  assert.equal(validFrameAddress(child, 79), true);
  assert.equal(
    child.initialize(owner, 1, 1, 1, () => {}),
    0x80000004,
  );
  assert.deepEqual(appended, [child]);
  assert.equal(attachModule(child, 'x', moduleBytes([7, 8])), 80);
  assert.equal(owner.moduleMemory[80], 7);
  child.disposeStorage();
  assert.equal(owner.retentionCount, 0);
  assert.equal(owner.heap.bytes.length, 0x8000);
  assert.equal(owner.moduleMemory[80], 7);
});
