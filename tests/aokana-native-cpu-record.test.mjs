import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoCpuProfile} from '../dist/engines/buriko/native/cpu-profile.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {createGroupCpu} from '../dist/engines/buriko/native/group-cpu.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';

function words(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({length: bytes.length / 4}, (_, index) => view.getUint32(index * 4, true));
}
function fixture({
  vendor = 'GenuineIntel',
  version = 0x000a0675,
  descriptors = [0x2c, 0x7a, 0x47],
  maxBasic = 4,
  maxExtended = 0x80000006,
  extra = new Map(),
  logicalCount = 12,
} = {}) {
  const [vendorB, vendorD, vendorC] = words(new TextEncoder().encode(vendor));
  const report = new Uint8Array(16);
  report[0] = 1;
  report.set(descriptors, 1);
  const calls = [],
    affinity = [];
  let raw = 0,
    timestamp = 0;
  const cpu = new BurikoCpuProfile(
    {
      cpuid(leaf, subleaf) {
        calls.push([leaf, subleaf]);
        if (extra.has(`${leaf}:${subleaf}`)) return extra.get(`${leaf}:${subleaf}`);
        switch (leaf) {
          case 0:
            return [maxBasic, vendorB, vendorC, vendorD];
          case 1:
            return [version, 0x123456ab, 0, 1 << 26];
          case 2:
            return words(report);
          case 0x80000000:
            return [maxExtended, 0, 0, 0];
          case 0x80000001:
            return [0, 0x1234beef, 0, 0];
          default:
            return [0, 0, 0, 0];
        }
      },
      readTimestampCounter() {
        return timestamp++ % 2 === 0 ? 10000n : 2500010000n;
      },
      setCurrentThreadAffinity(mask) {
        affinity.push(mask);
        return 0x100000003n;
      },
      logicalProcessorCount: () => logicalCount,
      logicalProcessorInformation: () => [
        {relationship: 3, processorMask: 0xffn},
        {relationship: 0, processorMask: 0x8000000000000005n},
        {relationship: 0, processorMask: 0xffffn},
      ],
    },
    new BurikoNativeClock(() => (raw += 125)),
  );
  return {cpu, calls, affinity};
}
function record(cpu) {
  const bytes = new Uint8Array(64);
  cpu.copyRecord(new DataView(bytes.buffer));
  return words(bytes);
}

test('CPU identity, cache descriptors, measured MHz and first-core count populate the shared record', () => {
  const {cpu, affinity} = fixture();
  assert.deepEqual(record(cpu), Array(16).fill(0));
  assert.equal(cpu.queryRecord(null), true);
  assert.deepEqual(
    record(cpu),
    [0, 6, 0xa7, 5, 0xab, 0x40080020, 0x40080100, 0x40082000, 2500, 12, 3, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(affinity, [1n, 3n]);
  assert.equal(cpu.firstCoreLogicalProcessorCount(), 3);
  assert.equal(cpu.feature(26), true);
  assert.equal(cpu.feature(25), false);
  assert.equal(cpu.feature(58), true);
  const output = new DataView(new ArrayBuffer(4));
  assert.equal(cpu.queryRecord(output, 5), true);
  assert.equal(output.getUint32(0, true), 0x40080020);
  assert.equal(cpu.queryRecord(output, 10), false);
  assert.equal(output.getUint32(0, true), 0x40080020);
});

test('CPU leaf-2 descriptors retain report order, invalid-register filtering and family-specific 49', () => {
  const report = [0x2c000001, 0x00007a41, 0x80000047, 0x00000049];
  const {cpu} = fixture({version: 0xf00, extra: new Map([['2:0', report]])});
  cpu.initialize();
  assert.equal(cpu.read(5), 0x40080020);
  assert.equal(cpu.read(6), 0x40080100);
  assert.equal(cpu.read(7), 0x40101000);
  const ordinary = fixture({version: 0x600, descriptors: [0x49]}).cpu;
  ordinary.initialize();
  assert.equal(ordinary.read(6), 0x40101000);
  assert.equal(ordinary.read(7), 0);
});

test('CPU deterministic cache records pack data and unified caches from exact dimensions', () => {
  const cache = (type, level, line, ways, sets, partitions = 1) => [
    type | (level << 5),
    (line - 1) | ((partitions - 1) << 12) | ((ways - 1) << 22),
    sets - 1,
    0,
  ];
  const {cpu, calls} = fixture({
    descriptors: [0xff],
    extra: new Map([
      ['4:0', cache(1, 1, 64, 8, 64)],
      ['4:1', cache(2, 1, 64, 16, 64)],
      ['4:2', cache(3, 2, 64, 4, 1024)],
      ['4:3', cache(3, 3, 64, 16, 8192)],
    ]),
  });
  cpu.initialize();
  assert.deepEqual([cpu.read(5), cpu.read(6), cpu.read(7)], [0x40080020, 0x40040100, 0x40102000]);
  assert.deepEqual(
    calls.filter(([leaf]) => leaf === 4),
    [
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
    ],
  );
});

test('CPU non-Intel identity and extended cache packing retain native bit operations', () => {
  const {cpu} = fixture({
    vendor: 'AuthenticAMD',
    version: 0x023a0f45,
    extra: new Map([
      ['2147483653:0', [0, 0, 0x40080040, 0]],
      ['2147483654:0', [0, 0, 0x02006040, 0]],
    ]),
  });
  cpu.initialize();
  assert.deepEqual(record(cpu).slice(0, 8), [1, 0x23f, 0xa4, 5, 0xbeef, 0x40080040, 0x40080200, 0]);
  for (const [vendor, expected] of [
    ['CentaurHauls', 2],
    ['GenuineTMx86', 3],
    ['OtherVendor!', 4],
  ]) {
    const profile = fixture({vendor}).cpu;
    profile.initialize();
    assert.equal(profile.read(0), expected);
  }
});

test('CPU max-leaf queries suppress unsupported leaves and brand normalization changes ASCII spaces only', () => {
  const limited = fixture({maxBasic: 1});
  assert.equal(limited.cpu.query(4, 3), null);
  assert.deepEqual(limited.calls, [[0, 0]]);
  const bytes = new Uint8Array(48);
  bytes.set(new TextEncoder().encode('   Example  CPU\tModel   3.20 GHz  '));
  const extra = new Map();
  for (let i = 0; i < 3; i++)
    extra.set(`${0x80000002 + i}:0`, words(bytes.subarray(i * 16, i * 16 + 16)));
  const {cpu} = fixture({extra});
  assert.equal(new TextDecoder().decode(cpu.brand()), 'Example CPU\tModel 3.20 GHz');
});

test('CPU wrappers copy the same 64-byte record and return the normalized brand status', () => {
  const brand = new Uint8Array(48);
  brand.set(new TextEncoder().encode(' Test CPU '));
  const extra = new Map();
  for (let i = 0; i < 3; i++)
    extra.set(`${0x80000002 + i}:0`, words(brand.subarray(i * 16, i * 16 + 16)));
  const {cpu} = fixture({extra});
  cpu.initialize();
  const output = new Uint8Array(96);
  output.fill(0xcc);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 4,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: {resolve: (_thread, value) => ({bytes: output, offset: value})}};
  for (const slot of createGroupCpu(cpu)) {
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
    push32(thread, slot.primary === 0x80 ? 0 : 64);
    assert.equal(slot.execute(context), 0);
    if (slot.primary === 0x81) assert.equal(pop32(thread), 1);
  }
  assert.deepEqual(words(output.subarray(0, 64)), record(cpu));
  assert.equal(new TextDecoder().decode(output.subarray(64, 72)), 'Test CPU');
  assert.equal(output[72], 0);
  assert.equal(output[73], 0xcc);
  assert.equal(thread.stackIndex, 0);
});
