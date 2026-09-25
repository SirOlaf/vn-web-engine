import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM joins admitted direct native callbacks before their owners close', async () => {
  const fixture = await createMountedVmFixture({seedCoreArchives: true});
  const {core, graph, memory, diagnostics, child, definitions, encode} = fixture;
  try {
    const raw = new Uint8Array(48);
    const header = new DataView(raw.buffer);
    header.setUint16(0, 2, true);
    header.setUint16(2, 2, true);
    header.setUint16(4, 24, true);
    header.setUint16(10, 1, true);
    header.setUint16(12, 3, true);
    header.setUint16(14, 4, true);
    await graph.resource.files.write(encode('C:\\game\\raw.bg'), raw);

    memory.globalMemory.set(new TextEncoder().encode('data.arc\0'), 0x140);
    memory.globalMemory.set(new TextEncoder().encode('entry\0'), 0x160);
    memory.globalMemory.set(new TextEncoder().encode('raw.bg\0'), 0x180);
    memory.globalMemory.fill(0xa5, 0x200, 0x208);
    const context = {thread: child.state, memory, diagnostics};
    const definition = (primary, secondary) => {
      const found = definitions.find(
        (entry) => entry.primary === primary && entry.secondary === secondary,
      );
      assert.ok(found);
      return found;
    };
    const start = (primary, secondary, args) => {
      for (const arg of args) push32(child.state, arg);
      return definition(primary, secondary).execute(context);
    };

    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(core.hasPendingNativeCallbacks, false);
    const resourceCall = start(0x80, 0x30, [0x200, 0x140, 0x160]);
    assert.ok(resourceCall instanceof Promise);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 1);
    assert.equal(core.hasPendingNativeCallbacks, true);
    const resourceJoined = core.joinPendingNativeCallbacks();
    assert.equal(await resourceCall, 0);
    await resourceJoined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 5);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x200, 0x208)],
      [41, 43, 47, 53, 59, 0xa5, 0xa5, 0xa5],
    );

    const headerCall = start(0x90, 0xc0, [6, 0, 0x180]);
    assert.ok(headerCall instanceof Promise);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 1);
    assert.equal(core.hasPendingNativeCallbacks, true);
    const headerJoined = core.joinPendingNativeCallbacks();
    assert.equal(await headerCall, 0);
    await headerJoined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(core.hasPendingNativeCallbacks, false);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(
      [
        graph.surfaces.snapshot(6).width,
        graph.surfaces.snapshot(6).height,
        graph.surfaces.snapshot(6).format,
      ],
      [2, 2, 1],
    );
    assert.deepEqual(
      [graph.surfaces.record(6).metadataX, graph.surfaces.record(6).metadataY],
      [3, 4],
    );
    const surface = graph.surfaces.snapshot(6);
    assert.deepEqual(
      Array.from({length: 4}, (_, index) =>
        surface.storage.view.getUint32(
          surface.offset + Math.floor(index / 2) * surface.stride + (index % 2) * 4,
          true,
        ),
      ),
      [0, 0, 0, 0],
    );
    assert.equal(start(0x90, 0x12, [6]), 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    await core.joinPendingNativeCallbacks();
  } finally {
    await fixture.close();
  }
});
