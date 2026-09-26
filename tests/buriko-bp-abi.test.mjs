import test from 'node:test';
import assert from 'node:assert/strict';
import {BURIKO_BP_ABI_169, BURIKO_BP_ABI_172} from '../dist/engines/buriko/bp/abi.js';
import {BurikoBpMemory, BurikoBpMemoryFault} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpInterpreter} from '../dist/engines/buriko/bp/interpreter.js';
import {BurikoBpModuleExtensions} from '../dist/engines/buriko/bp/module-extensions.js';
import {createPrimaryOpcodes} from '../dist/engines/buriko/bp/opcodes/index.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeBank, burikoNativeSlots} from '../dist/engines/buriko/native/registry.js';
import {BURIKO_PRIMARY_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BURIKO_169_PRIMARY_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory-169.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];

for (const abi of [BURIKO_BP_ABI_169, BURIKO_BP_ABI_172]) {
  test(`BP ${abi.compatibility} executes address, stack, arithmetic and text contracts together`, () => {
    const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 256,
      frameCapacity: 128,
    });
    const memory = new BurikoBpMemory(new Uint8Array(64), abi);
    const notices = [];
    const diagnostics = new BurikoBpDiagnostics((notice) => notices.push(notice), abi);
    const slots = burikoNativeSlots(abi);
    // The test program invokes no native service; fillers prove the selected bank is complete.
    const bank = new BurikoNativeBank(
      Object.entries(slots).flatMap(([primary, entries]) =>
        Object.entries(entries).map(([secondary, nativeAddress]) => ({
          primary: Number(primary),
          secondary: Number(secondary),
          nativeAddress,
          name: 'Unselected system fixture service',
          execute: () => assert.fail('Native fixture service selected'),
        })),
      ),
      abi,
    );
    const inventory =
      abi.compatibility === '1.69'
        ? BURIKO_169_PRIMARY_SLOT_ADDRESSES
        : BURIKO_PRIMARY_SLOT_ADDRESSES;
    const fillers = Object.fromEntries(
      Object.keys(inventory)
        .map(Number)
        .filter((opcode) => !slots[opcode] && opcode !== 0xff)
        .map((opcode) => [opcode, () => assert.fail(`Host opcode selected ${opcode}`)]),
    );
    const primary = {...fillers, ...createPrimaryOpcodes(new BurikoNativeText(), {}, abi)};
    const vm = new BurikoBpInterpreter(
      primary,
      bank,
      new BurikoBpModuleExtensions({readModule: () => assert.fail('Extension selected')}),
      () => ({thread, memory, diagnostics}),
      abi,
    );
    thread.frameCursor = 32;
    // Store through a constructed frame address, then leave a global store's version-specific result.
    const program = [0x04, 4, 0, 0x02, ...u32(0x12345678), 0x09, 2, 0x00, 7, 0x00, 0, 0x23];
    const stringPush = program.length;
    program.push(0x05, (200 - stringPush) & 255, (200 - stringPush) >>> 8, 0x6c);
    program.push(
      0x02,
      ...u32(30 * 65536),
      0x48,
      0x02,
      ...u32(60 * 65536),
      0x49,
      0x00,
      1,
      0x00,
      1,
      0x43,
    );
    thread.moduleMemory.set(program);
    thread.moduleMemory.set([0x2c, 0], 200);
    diagnostics.registerWriteWatch(thread, abi.frameTag + 28, 4, new Uint8Array([119]));
    diagnostics.writeWatchEnabled = true;
    while (thread.pc < program.length) assert.equal(vm.step(thread), 0);
    assert.equal(memory.readU32(thread, abi.frameTag + 28), 0x12345678);
    assert.equal(notices.length, 1);
    const actual = Array.from(thread.operandStack.subarray(0, thread.stackIndex));
    assert.deepEqual(
      actual,
      abi.compatibility === '1.69'
        ? [0x12345678, 0xffffffff, 0x2c, 0, 1, 32767, 32768, 45 * 65536]
        : [0x80000000, 1, 0x2c, 0, 1, 32767, 32768, 45 * 65536],
    );
    assert.equal(memory.resolve(thread, abi.moduleTag + 200).bytes, thread.moduleMemory);
    assert.throws(
      () => memory.resolve(thread, abi.compatibility === '1.69' ? 0x10000000 : 0x40000000),
      BurikoBpMemoryFault,
    );
    thread.pc = 220;
    thread.moduleMemory[220] = 0x03;
    assert.equal(vm.dispatchNext(thread).defined, abi.compatibility === '1.72');
  });
}

test('BP pool lifetimes retain each ABI bank layout and do not alias indirect handles', () => {
  const older = new BurikoBpMemory(new Uint8Array(64), BURIKO_BP_ABI_169);
  const newer = new BurikoBpMemory(new Uint8Array(64), BURIKO_BP_ABI_172);
  const oldAddresses = Array.from({length: 48}, () => older.allocatePooled(4));
  assert.equal(oldAddresses[0], 0x40000000);
  assert.equal(oldAddresses[47], 0xfc000000);
  assert.equal(older.allocatePooled(4), 0);
  assert.equal(older.freePooled(oldAddresses[7] + 1), false);
  assert.equal(older.freePooled(oldAddresses[7]), true);
  assert.equal(older.allocatePooled(4), oldAddresses[7]);
  assert.equal(newer.allocatePooled(4), 0x40000000);
  assert.equal(newer.allocatePooled(4), 0x40001000);
  assert.throws(() => older.createBuffer(4), /no indirect/);
  const buffer = newer.createBuffer(4);
  assert.equal(buffer.result, 0);
  const t = new BurikoBpThread({id: 2, operandCapacity: 4, moduleCapacity: 4, frameCapacity: 4});
  assert.equal(newer.resolve(t, buffer.address).bytes.length, 4);
  assert.equal(older.resolve(t, buffer.address).bytes, t.heap.bytes);
  assert.throws(() => older.pointer(t, buffer.address, 4), /outside backing allocation/);
});
