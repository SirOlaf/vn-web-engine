import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoGdbRestore} from '../dist/engines/buriko/native/gdb-restore.js';
import {createGroup81GdbRestore} from '../dist/engines/buriko/native/group-81-gdb-restore.js';
import {BurikoNamedBitArrays} from '../dist/engines/buriko/native/named-bit-arrays.js';
import {BurikoStringLists} from '../dist/engines/buriko/native/string-lists.js';

const text = (value) => new TextEncoder().encode(value);
const strings = (...values) => text(values.join('\0') + '\0');
const pointer = (bytes) => ({bytes, offset: 0});

function dword(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatenate(...pieces) {
  const result = new Uint8Array(pieces.reduce((size, piece) => size + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    result.set(piece, offset);
    offset += piece.byteLength;
  }
  return result;
}

function gdb(first, second) {
  const namedBits = concatenate(
      dword(2),
      strings('flags'),
      dword(12),
      Uint8Array.of(0x21, 0x40),
      strings('extra'),
      dword(9),
      Uint8Array.of(0x80, 0x80),
    ),
    decoded = concatenate(
      new Uint8Array(0x1c),
      dword(first.byteLength),
      first,
      dword(second.byteLength),
      second,
      dword(2),
      strings('alpha', 'beta'),
      namedBits,
    ),
    view = new DataView(decoded.buffer);
  decoded.set(text('BURIKO GDB 3.00\0'));
  view.setUint32(0x10, decoded.byteLength, true);
  view.setUint32(0x14, 123, true);
  view.setUint32(0x18, 456, true);
  return decoded;
}

function sdc(decoded) {
  const compressed = [];
  for (let offset = 0; offset < decoded.byteLength; offset += 128) {
    const chunk = decoded.subarray(offset, Math.min(offset + 128, decoded.byteLength));
    compressed.push(chunk.byteLength - 1, ...chunk);
  }
  const plain = Uint8Array.from(compressed),
    stored = new Uint8Array(plain.byteLength),
    seedValue = 0x13579bdf;
  let seed = seedValue;
  for (let index = 0; index < plain.byteLength; index++) {
    const product = Math.imul(seed, 0x015a4e35) >>> 0;
    seed = (product + 1) >>> 0;
    stored[index] = (plain[index] + ((product >>> 16) & 255)) & 255;
  }
  const encoded = new Uint8Array(32 + stored.byteLength),
    view = new DataView(encoded.buffer);
  encoded.set(text('SDC FORMAT 1.00\0'));
  view.setUint32(16, seedValue, true);
  view.setUint32(20, stored.byteLength, true);
  view.setUint32(24, decoded.byteLength, true);
  encoded.set(stored, 32);
  view.setUint16(
    28,
    stored.reduce((sum, value) => (sum + value) & 0xffff, 0),
    true,
  );
  view.setUint16(
    30,
    stored.reduce((xor, value) => xor ^ value, 0),
    true,
  );
  return encoded;
}

test('81 80 restores ordinary GDB regions, reserved strings, and named bits through shared owners', () => {
  const first = Uint8Array.of(3, 5, 7, 11),
    second = Uint8Array.of(13, 17, 19),
    encoded = sdc(gdb(first, second)),
    sourceAddress = 0x101000,
    memory = new BurikoBpMemory(new Uint8Array(sourceAddress + encoded.byteLength + 64).fill(0x5a)),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    stringsOwner = new BurikoStringLists(),
    bits = new BurikoNamedBitArrays(),
    restore = new BurikoGdbRestore(stringsOwner, bits),
    [definition] = createGroup81GdbRestore(restore),
    firstCapacity = 0x40,
    secondCapacity = 0x44,
    firstDestination = 0x100,
    secondDestination = 0x800;
  memory.globalMemory.set(encoded, sourceAddress);
  stringsOwner.append(0x80000000, pointer(strings('kept')));
  bits.replaceData(pointer(strings('flags')), 5, pointer(Uint8Array.of(0x90)));
  for (const value of [
    firstDestination,
    firstCapacity,
    secondDestination,
    secondCapacity,
    sourceAddress,
  ])
    push32(thread, value);

  assert.equal(definition.primary, 0x81);
  assert.equal(definition.secondary, 0x80);
  assert.equal(definition.nativeAddress, 0x1400eb100);
  assert.equal(definition.execute({thread, memory, diagnostics: {}}), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(memory.readU32(thread, firstCapacity), 0x400);
  assert.equal(memory.readU32(thread, secondCapacity), 0x100000);
  assert.deepEqual(
    memory.globalMemory.slice(firstDestination, firstDestination + first.length),
    first,
  );
  assert.equal(
    memory.globalMemory
      .subarray(firstDestination + first.length, firstDestination + 0x400)
      .every((value) => value === 0),
    true,
  );
  assert.deepEqual(
    memory.globalMemory.slice(secondDestination, secondDestination + second.length),
    second,
  );
  assert.equal(
    memory.globalMemory
      .subarray(secondDestination + second.length, secondDestination + 0x100000)
      .every((value) => value === 0),
    true,
  );

  const reserved = new Uint8Array(64),
    reservedBytes = strings('kept', 'alpha', 'beta');
  assert.equal(stringsOwner.count(0x80000000), 3);
  assert.equal(stringsOwner.copyAll(pointer(reserved), 0x80000000), reservedBytes.byteLength);
  assert.deepEqual(reserved.slice(0, reservedBytes.byteLength), reservedBytes);
  assert.deepEqual(bits.read(pointer(strings('flags'))), {
    name: strings('flags'),
    bitCount: 12,
    data: Uint8Array.of(0xb1, 0x40),
  });
  assert.deepEqual(bits.read(pointer(strings('extra'))), {
    name: strings('extra'),
    bitCount: 9,
    data: Uint8Array.of(0x80, 0x80),
  });
});
