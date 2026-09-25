import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted immediate BMP load joins its callback and exposes bottom-up pixels', async () => {
  const fixture = await createMountedVmFixture();
  const {core, graph, memory, diagnostics, child, definitions, encode, invoke} = fixture;
  try {
    const bmp = new Uint8Array(70);
    const header = new DataView(bmp.buffer);
    header.setUint16(0, 0x4d42, true);
    header.setUint32(2, bmp.length, true);
    header.setUint32(10, 54, true);
    header.setUint32(14, 40, true);
    header.setInt32(18, 2, true);
    header.setInt32(22, 2, true);
    header.setUint16(26, 1, true);
    header.setUint16(28, 24, true);
    header.setUint32(34, 16, true);
    // BMP rows are bottom-up, BGR, and padded to four-byte boundaries.
    bmp.set([255, 0, 0, 255, 255, 255, 0xa5, 0xa5, 0, 0, 255, 0, 255, 0, 0xa5, 0xa5], 54);
    await graph.resource.files.write(encode('C:\\game\\ordinary.bmp'), bmp);
    memory.globalMemory.set(encode('C:\\game\\ordinary.bmp'), 0x100);
    memory.globalMemory.fill(0xa5, 0x200, 0x204);
    assert.equal(graph.resource.resources.files, graph.resource.files);
    assert.equal(graph.resource.resources.mainProcessing, graph.resource.processing);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    const slot = definitions.find(({primary, secondary}) => primary === 0x92 && secondary === 0x1f);
    assert.ok(slot);
    push32(child.state, 1);
    push32(child.state, 0x100);
    const pending = slot.execute({thread: child.state, memory, diagnostics});
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
    const surface = graph.surfaces.snapshot(1);
    assert.deepEqual([surface.width, surface.height, surface.format], [2, 2, 1]);
    const output = new DataView(memory.globalMemory.buffer);
    for (const [x, y, expected] of [
      [0, 0, 0xff0000],
      [1, 0, 0x00ff00],
      [0, 1, 0x0000ff],
      [1, 1, 0xffffff],
    ]) {
      assert.equal(await invoke(0x92, 0x17, [0x200, 1, x, y], 0), 1);
      assert.equal(pop32(child.state), 0);
      assert.equal(output.getUint32(0x200, true), expected);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(await invoke(0x90, 0x12, [1], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
