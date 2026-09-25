import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM binds object coordinates, properties, and parentage to its graph', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, definitions, invoke} = fixture;
  try {
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.manager.environment.compositor, graph.compositor);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x91 && [0x31, 0x33, 0x36, 0x37, 0x3d, 0x3e, 0x3f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x31, 0x33, 0x36, 0x37, 0x3d, 0x3e, 0x3f],
    );
    assert.equal(graph.surfaces.allocate(0, 2, 1, 1), 1);
    const spriteHandle = graph.manager.createSprite();
    const childHandle = graph.manager.createSprite();
    const sprite = graph.manager.find('sprite', spriteHandle);
    const spriteChild = graph.manager.find('sprite', childHandle);
    assert.ok(sprite && spriteChild);
    for (const object of [sprite, spriteChild]) {
      assert.equal(object.initializeSimple(0, 0, 0, 0, 0, 3), 0);
      object.setActivation(1);
    }
    sprite.setCoordinates(0x10000, 0x20000, 0x30000);
    memory.globalMemory.fill(0xa5, 0x500, 0x510);
    assert.equal(await invoke(0x91, 0x38, [0x501, spriteHandle, 0x20], 0), 0);
    const propertyOutput = new DataView(memory.globalMemory.buffer);
    assert.deepEqual(
      [0, 1, 2].map((index) => propertyOutput.getUint32(0x501 + index * 4, true)),
      [0x10000, 0x20000, 0x30000],
    );
    assert.equal(memory.globalMemory[0x500], 0xa5);
    assert.equal(memory.globalMemory[0x50d], 0xa5);
    assert.equal(sprite.setProperty(0x8101, 1, 0), 0);
    assert.equal(sprite.setProperty(0xc1, 1, 0), 0);
    for (const [secondary, values] of [
      [0x33, [spriteHandle, 1 << 16, 1 << 16, 2 << 16]],
      [0x37, [spriteHandle, 3 << 16, 4 << 16, 5 << 16]],
      [0x36, [spriteHandle, 6 << 16, 7 << 16, 8 << 16]],
    ])
      assert.equal(await invoke(0x91, secondary, values, 0), 0);
    assert.deepEqual(sprite.effectiveCoordinates(), {
      x: 10 << 16,
      y: 12 << 16,
      z: 15 << 16,
    });
    assert.equal(
      graph.manager.lists.snapshot(false).find((entry) => entry.object === sprite).key,
      sprite.sortKey(),
    );
    assert.equal(await invoke(0x91, 0x3e, [spriteHandle, childHandle, 3, 0], 0), 0);
    assert.equal(spriteChild.parent, sprite);
    assert.deepEqual(Array.from(sprite.children()), [spriteChild]);
    const effectivePosition = async (handle) => {
      assert.equal(await invoke(0x91, 0x3d, [0x520, handle], 0), 0);
      return [propertyOutput.getInt32(0x520, true), propertyOutput.getInt32(0x524, true)];
    };
    assert.deepEqual(await effectivePosition(spriteHandle), [1, 1]);
    assert.deepEqual(await effectivePosition(childHandle), [4, 1]);
    assert.equal(await invoke(0x91, 0x31, [spriteHandle, 1], 0), 0);
    assert.equal(sprite.inputActive(), 0);
    assert.equal(spriteChild.inputActive(), 0);
    assert.equal(await invoke(0x91, 0x31, [spriteHandle, 0], 0), 0);
    assert.equal(await invoke(0x91, 0x3f, [spriteHandle, childHandle], 0), 0);
    assert.equal(spriteChild.parent, null);
    assert.deepEqual(Array.from(sprite.children()), []);
    assert.equal(graph.manager.destroy('sprite', childHandle), true);
    assert.equal(graph.manager.destroy('sprite', spriteHandle), true);
    assert.equal(graph.surfaces.release(0), 1);
  } finally {
    await fixture.close();
  }
});
