import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:EC/ED use the selected synchronous named-mutex owner', async () => {
  const calls = [];
  const open = new Set();
  const host = {
    createOwned(pointer) {
      assert.ok(pointer);
      const end = pointer.bytes.indexOf(0, pointer.offset);
      const name = new TextDecoder().decode(pointer.bytes.subarray(pointer.offset, end));
      const handle = {name};
      calls.push(['create', name]);
      open.add(handle);
      return {handle, lastError: 0};
    },
    release(handle) {
      assert.ok(open.has(handle));
      calls.push(['release', handle.name]);
    },
    close(handle) {
      assert.ok(open.delete(handle));
      calls.push(['close', handle.name]);
    },
  };
  const fixture = await createMountedVmFixture({namedMutexHost: host});
  const {graph, definitions, child, memory, invoke, encode} = fixture;
  try {
    assert.equal(graph.namedMutexHost, host);
    assert.equal(graph.namedMutexes.host, host);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x81 && [0xec, 0xed].includes(secondary))
        .map(({secondary}) => secondary),
      [0xec, 0xed],
    );

    memory.globalMemory.set(encode('alpha'), 0x200);
    memory.globalMemory.set(encode('beta'), 0x220);
    assert.equal(await invoke(0x81, 0xec, [0x200], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x81, 0xec, [0x220], 0), 1);
    assert.equal(pop32(child.state), 2);
    assert.deepEqual(graph.namedMutexes.ids, [2, 1]);
    memory.globalMemory[0x200] = 88;
    assert.deepEqual([...graph.namedMutexes.name(1)], [...encode('alpha')]);
    assert.deepEqual(calls, [
      ['create', 'alpha'],
      ['create', 'beta'],
    ]);

    assert.equal(await invoke(0x81, 0xed, [1], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await invoke(0x81, 0xed, [2], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(calls, [
      ['create', 'alpha'],
      ['create', 'beta'],
      ['release', 'alpha'],
      ['close', 'alpha'],
      ['release', 'beta'],
      ['close', 'beta'],
    ]);
    assert.equal(open.size, 0);
    assert.deepEqual(graph.namedMutexes.ids, []);
    assert.equal(graph.namedMutexes.pendingCloseCount, 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);

    memory.globalMemory.set(encode('gamma'), 0x240);
    assert.equal(await invoke(0x81, 0xec, [0x240], 0), 1);
    assert.equal(pop32(child.state), 3);
    assert.deepEqual(graph.namedMutexes.ids, [3]);
    await fixture.close();
    assert.deepEqual(calls.slice(-3), [
      ['create', 'gamma'],
      ['release', 'gamma'],
      ['close', 'gamma'],
    ]);
    assert.equal(open.size, 0);
    assert.deepEqual(graph.namedMutexes.ids, []);
    assert.equal(graph.namedMutexes.pendingCloseCount, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits named mutex callbacks without a selected host', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.namedMutexHost, null);
    assert.equal(fixture.graph.namedMutexes, null);
    assert.deepEqual(
      fixture.definitions.filter(
        ({primary, secondary}) => primary === 0x81 && [0xec, 0xed].includes(secondary),
      ),
      [],
    );
  } finally {
    await fixture.close();
  }
});
