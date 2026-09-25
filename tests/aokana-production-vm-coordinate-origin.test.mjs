import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted perspective output drives Sprite coordinates through the shared global origin', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const bp = new DataView(memory.globalMemory.buffer);
  try {
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x90 && secondary === 0xcf).length,
      1,
    );
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x05, 0x06].includes(secondary))
        .map(({secondary}) => secondary),
      [0x06],
    );
    await call(0x90, 0x11, [0, 2, 2, 2]);
    await call(0x90, 0x13, [0, 0xff204060]);
    await call(0x90, 0x50, [], 1);
    const handle = pop32(child.state);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    await call(0x90, 0x56, [handle, 0, 0, 0, 0x80, 0, 2]);
    assert.equal(sprite.positionUsesCoordinates, 1);
    assert.equal(sprite.usesGlobalOrigin, 1);

    [20 << 16, 20 << 16, 1 << 16].forEach((value, index) =>
      bp.setInt32(0x100 + index * 4, value, true),
    );
    memory.globalMemory.fill(0xa5, 0x200, 0x20c);
    await call(0x90, 0xcf, [0x200, 0x100, 1, 3]);
    assert.deepEqual([bp.getInt32(0x200, true), bp.getInt32(0x204, true)], [10 << 16, 15 << 16]);
    assert.deepEqual([...memory.globalMemory.subarray(0x208, 0x20c)], [0xa5, 0xa5, 0xa5, 0xa5]);
    await call(0x91, 0x33, [handle, bp.getInt32(0x200, true), bp.getInt32(0x204, true), 0]);
    assert.deepEqual(sprite.position(), {x: 10, y: 15});
    const position = async () => {
      memory.globalMemory.fill(0xa5, 0x300, 0x30c);
      await call(0x91, 0x3d, [0x300, handle]);
      assert.deepEqual([...memory.globalMemory.subarray(0x308, 0x30c)], [0xa5, 0xa5, 0xa5, 0xa5]);
      return [bp.getInt32(0x300, true), bp.getInt32(0x304, true)];
    };
    assert.deepEqual(await position(), [10, 15]);
    await call(0x91, 0x06, [7, -4]);
    assert.deepEqual(graph.manager.environment.origin, {x: 7, y: -4});
    assert.deepEqual(await position(), [17, 11]);
    await call(0x91, 0x06, [0, 0]);
    assert.deepEqual(await position(), [10, 15]);
    await call(0x90, 0x51, [handle]);
    assert.equal(graph.manager.find('sprite', handle), null);
    await call(0x90, 0x12, [0], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
