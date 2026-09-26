import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted C0:F0 reads loose BWEF pairs through shared resources and BP memory', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, core, memory, diagnostics, child, definitions, encode} = fixture;
  try {
    assert.equal(graph.resource.loading.resources, graph.resource.resources);
    assert.equal(graph.resource.resources.files, graph.resource.files);
    const definition = definitions.find(
      ({primary, secondary}) => primary === 0xc0 && secondary === 0xf0,
    );
    assert.ok(definition);
    const bytes = new Uint8Array(0x128);
    const header = new DataView(bytes.buffer);
    header.setBigUint64(0, 0x2020202066657762n, true);
    header.setUint32(0x14, 2, true);
    header.setInt32(0x18, -7, true);
    header.setInt32(0x120, 0x7fffffff, true);
    header.setInt32(0x124, -10, true);
    await graph.resource.files.write(encode('C:\\game\\pairs.bwef'), bytes);
    memory.globalMemory.set(new TextEncoder().encode('pairs.bwef\0'), 0x100);
    const view = new DataView(memory.globalMemory.buffer);
    view.setUint32(0x290, 0xaaaaaaaa, true);
    for (let offset = 0; offset < 20; offset += 4) view.setUint32(0x300 + offset, 0xbbbbbbbb, true);

    for (const value of [0x300, 0x290, 0, 0x100, 2]) push32(child.state, value);
    const pending = definition.execute({thread: child.state, memory, diagnostics});
    assert.ok(pending instanceof Promise);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const joined = core.joinPendingNativeCallbacks();
    assert.equal(await pending, 0);
    await joined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(view.getUint32(0x290, true), 2);
    assert.deepEqual(
      [0, 4, 8, 12].map((offset) => view.getInt32(0x300 + offset, true)),
      [-2147483647, -7, -8, -7],
    );
    assert.equal(view.getUint32(0x310, true), 0xbbbbbbbb);
  } finally {
    await fixture.close();
  }
});
