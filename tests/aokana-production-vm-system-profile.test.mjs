import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const ansi = (value) => new TextEncoder().encode(value);
const profileSlots = ['80:d', '81:8', '81:9', '81:c', '81:d'];
const slotKey = ({primary, secondary}) => `${primary.toString(16)}:${secondary.toString(16)}`;

test('mounted system callbacks share one explicit host and lazy version record', async () => {
  const calls = [];
  const systemProfileHost = {
    readUserName() {
      calls.push('user');
      return Uint8Array.of(0x83, 0x65, 0x83, 0x58, 0x83, 0x67);
    },
    readComputerName() {
      calls.push('computer');
      return ansi('TEST-PC');
    },
    readVersion() {
      calls.push('version');
      return {major: 6, minor: 1, build: 7601, platform: 2, servicePack: ansi('Service Pack 1')};
    },
    readLegacyPhysicalMemory() {
      calls.push('legacy');
      return {total: 8n << 30n, available: 1536n << 20n};
    },
    readPhysicalMemory() {
      calls.push('extended');
      return {total: (8n << 30n) + 700n, available: (1536n << 20n) + 333n};
    },
  };
  const fixture = await createMountedVmFixture({systemProfileHost});
  const {graph, core, child, memory, definitions, diagnostics} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = (primary, secondary, args, pushes = 0) => {
    const slot = definitions.find(
      (entry) => entry.primary === primary && entry.secondary === secondary,
    );
    assert.ok(slot);
    for (const value of args) push32(child.state, value);
    assert.equal(slot.execute({thread: child.state, memory, diagnostics}), 0);
    assert.equal(child.state.stackIndex, pushes);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.systemProfileHost, systemProfileHost);
    assert.equal(graph.systemProfile.host, systemProfileHost);
    assert.deepEqual(
      definitions.filter((definition) => profileSlots.includes(slotKey(definition))).map(slotKey),
      profileSlots,
    );

    call(0x80, 0x0d, [], 2);
    assert.equal(pop32(child.state), 1536 * 1048576);
    assert.equal(pop32(child.state), 0x7fffffff);
    assert.equal(child.state.stackIndex, 0);

    memory.globalMemory.fill(0xa5, 0xff, 0x1c9);
    call(0x81, 0x08, [0x100]);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x100, 0x107)],
      [0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0],
    );
    call(0x81, 0x09, [0x120]);
    assert.deepEqual([...memory.globalMemory.subarray(0x120, 0x128)], [...ansi('TEST-PC'), 0]);

    call(0x81, 0x0c, [0x140, 0x160]);
    call(0x81, 0x0c, [0x180, 0x1a0]);
    for (const address of [0x140, 0x180]) {
      assert.deepEqual(
        Array.from({length: 4}, (_, index) => view.getUint32(address + index * 4, true)),
        [6, 1, 7601, 2],
      );
    }
    for (const address of [0x160, 0x1a0])
      assert.deepEqual(
        [...memory.globalMemory.subarray(address, address + 15)],
        [...ansi('Service Pack 1'), 0],
      );

    call(0x81, 0x0d, [0x1c0, 0x1c4]);
    assert.equal(view.getUint32(0x1c0, true), 8192);
    assert.equal(view.getUint32(0x1c4, true), 1536);
    for (const address of [
      0xff, 0x107, 0x11f, 0x128, 0x13f, 0x150, 0x15f, 0x16f, 0x17f, 0x190, 0x19f, 0x1af, 0x1bf,
      0x1c8,
    ])
      assert.equal(memory.globalMemory[address], 0xa5);
    assert.deepEqual(calls, ['legacy', 'user', 'computer', 'version', 'extended']);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits system callbacks without a selected host', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.systemProfileHost, null);
    assert.equal(fixture.graph.systemProfile, null);
    assert.deepEqual(
      fixture.definitions
        .filter((definition) => profileSlots.includes(slotKey(definition)))
        .map(slotKey),
      [],
    );
  } finally {
    await fixture.close();
  }
});
