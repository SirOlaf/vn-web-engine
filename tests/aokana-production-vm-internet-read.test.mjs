import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AOKANA_INTERNET_USER_AGENT} from '../dist/engines/buriko/games/aokana/native/internet-reads.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:31 shares selected internet owner for synchronous and serial process reads', async () => {
  const requests = [];
  const body = Uint8Array.of(2, 3, 5, 7, 11, 13);
  let complete;
  const completion = new Promise((resolve) => {
    complete = resolve;
  });
  const internetReadHost = {
    async read(request) {
      requests.push(['read', request]);
      return {kind: 'opened', body};
    },
    start(request) {
      requests.push(['start', request]);
      return {completion, cancelSession() {}, dispose() {}};
    },
  };
  const fixture = await createMountedVmFixture({internetReadHost});
  const {graph, definitions, memory, child, core, invoke} = fixture;
  try {
    assert.equal(graph.internetReadHost, internetReadHost);
    assert.equal(graph.internetReads.host, internetReadHost);
    assert.equal(graph.internetReads.files, graph.resource.files);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x81 && secondary === 0x31).length,
      1,
    );
    memory.globalMemory.set(graph.text.encodeWide('https://example.test/data.bin', 1), 0x100);
    assert.equal(await invoke(0x81, 0x31, [0x300, 0x100, 2, 3], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual([...memory.globalMemory.subarray(0x300, 0x303)], [5, 7, 11]);
    assert.equal(child.process, null);

    assert.equal(await invoke(0x80, 0x53, [], 0), 0);
    assert.equal(core.control.asynchronousResourceLoads, 1);
    assert.equal(await invoke(0x81, 0x31, [0x400, 0x100, 1, 3], 2), 0);
    assert.equal(core.control.asynchronousResourceLoads, 0);
    assert.notEqual(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    assert.equal(await child.pollProcess(false), 0);
    complete({kind: 'opened', body});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual([...memory.globalMemory.subarray(0x400, 0x403)], [3, 5, 7]);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);

    assert.deepEqual(requests.map(([kind]) => kind), ['read', 'start']);
    for (const [kind, request] of requests) {
      assert.equal(request.url, 'https://example.test/data.bin');
      assert.equal(request.userAgent, AOKANA_INTERNET_USER_AGENT);
      assert.equal(request.reload, true);
      assert.equal(request.destination.bytes, memory.globalMemory);
      assert.equal(request.destination.offset, kind === 'read' ? 0x300 : 0x400);
      assert.equal(request.offset, kind === 'read' ? 2 : 1);
      assert.equal(request.length, 3);
    }
    await fixture.close();
    assert.equal(graph.internetReads.admissionClosed, true);
    assert.equal(graph.internetReads.quiesced, true);
  } finally {
    await fixture.close();
  }
});

test('mounted catalog selects the browser fetch host for 81:31', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.ok(fixture.graph.internetReadHost);
    assert.ok(fixture.graph.internetReads);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0x31),
      true,
    );
  } finally {
    await fixture.close();
  }
});
