import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted Sprite dynamic mask aligns shared surfaces and detaches before destruction', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const bounds = {left: 0, top: 0, right: 7, bottom: 1};
  try {
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x91 && secondary === 0x55).length,
      1,
    );
    for (const [id, format] of [
      [0, 1],
      [1, 2],
      [2, 1],
    ])
      await call(0x90, 0x11, [id, 8, 2, format]);
    await call(0x90, 0x13, [0, 0x808080]);
    await call(0x90, 0x13, [1, 0x80000000]);
    await call(0x90, 0x50, [], 1);
    const ownerHandle = pop32(child.state);
    await call(0x90, 0x50, [], 1);
    const maskHandle = pop32(child.state);
    const owner = graph.manager.find('sprite', ownerHandle);
    const mask = graph.manager.find('sprite', maskHandle);
    assert.ok(owner && mask);
    await call(0x90, 0x56, [ownerHandle, 0, 0, 0, 0x80, 0, 2]);
    await call(0x90, 0x56, [maskHandle, 0, 0, 1, 0x80, 0, 2]);
    await call(0x90, 0x54, [ownerHandle, 1]);
    await call(0x90, 0x54, [maskHandle, 1]);
    await call(0x91, 0x55, [ownerHandle, maskHandle], 1);
    assert.equal(pop32(child.state), 0);
    const output = graph.surfaces.snapshot(2);
    const draw = () => {
      clearAokanaBitmap(output);
      owner.draw(output, bounds, owner.sortKey());
    };
    const read = async (x, y) => {
      assert.equal(await invoke(0x92, 0x17, [0x200, 2, x, y], 0), 1);
      assert.equal(pop32(child.state), 0);
      assert.equal(child.state.stackIndex, 0);
      return new DataView(memory.globalMemory.buffer).getUint32(0x200, true) & 0xffffff;
    };
    draw();
    assert.equal(await read(0, 0), 0x3f3f3f);
    assert.equal(await read(7, 1), 0x3f3f3f);
    await call(0x91, 0x33, [maskHandle, 2 << 16, 0, 0]);
    assert.deepEqual(mask.position(), {x: 2, y: 0});
    draw();
    assert.equal(await read(0, 0), 0);
    assert.equal(await read(2, 0), 0x3f3f3f);
    assert.equal(await read(7, 1), 0x3f3f3f);
    await call(0x91, 0x55, [ownerHandle, 0], 1);
    assert.equal(pop32(child.state), 0);
    draw();
    assert.equal(await read(0, 0), 0x808080);
    assert.equal(await read(7, 1), 0x808080);
    await call(0x90, 0x51, [maskHandle]);
    await call(0x90, 0x51, [ownerHandle]);
    assert.equal(graph.manager.find('sprite', maskHandle), null);
    assert.equal(graph.manager.find('sprite', ownerHandle), null);
    for (const id of [2, 1, 0]) {
      await call(0x90, 0x12, [id], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
