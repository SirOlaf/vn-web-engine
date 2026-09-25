import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaDriveGeometryProfile} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:32 reads a real file with the selected sector geometry', async () => {
  const sectors = Array(26).fill(null);
  sectors[2] = 4;
  const profile = new AokanaDriveGeometryProfile(sectors);
  const roots = [];
  const driveGeometryHost = {
    readBytesPerSector(root) {
      roots.push(root);
      return profile.readBytesPerSector(root);
    },
  };
  const fixture = await createMountedVmFixture({driveGeometryHost});
  const {graph, core, child, memory, definitions, diagnostics, encode} = fixture;
  try {
    assert.equal(graph.resource.driveGeometryHost, driveGeometryHost);
    assert.equal(graph.resource.files.text, graph.text);
    assert.equal(graph.resource.files.media, graph.resource.media);
    const slot = definitions.find(({primary, secondary}) => primary === 0x81 && secondary === 0x32);
    assert.ok(slot);

    const contents = Uint8Array.from({length: 12}, (_, index) => index + 1);
    await graph.resource.files.write(encode('C:\\game\\data.bin'), contents);
    const pathBytes = encode('C:\\GAME\\DATA.BIN');
    memory.globalMemory.set(pathBytes, 0x100);
    memory.globalMemory.fill(0xa5, 0x1ff, 0x209);
    memory.globalMemory.fill(0xa5, 0x2ff, 0x309);
    for (const value of [0x300, 0x200, 0x100, 5]) push32(child.state, value);
    const completion = slot.execute({thread: child.state, memory, diagnostics});
    assert.ok(completion instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    await core.joinPendingNativeCallbacks();
    assert.equal(await completion, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual(roots, ['c:\\']);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x200, true), 5);
    assert.deepEqual([...memory.globalMemory.subarray(0x300, 0x305)], [1, 2, 3, 4, 5]);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x100, 0x100 + pathBytes.length)],
      [...pathBytes],
    );
    for (const address of [0x1ff, 0x204, 0x208, 0x2ff, 0x305, 0x308])
      assert.equal(memory.globalMemory[address], 0xa5);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits 81:32 without selected geometry', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.resource.driveGeometryHost, null);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0x32),
      false,
    );
  } finally {
    await fixture.close();
  }
});
