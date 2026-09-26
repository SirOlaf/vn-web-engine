import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM shakes and hits a Sprite, then fits graph surface pixels with bars', async () => {
  let tick = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => tick});
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 && [0x2c, 0x3c, 0x3d, 0xca].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x2c, 0x3c, 0x3d, 0xca],
    );
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.input.usesClock(graph.clock), true);
    assert.equal(graph.surfaces.allocate(0, 4, 2, 1), 1);
    assert.equal(graph.surfaces.fill(0, 0x224466), 1);
    assert.equal(graph.surfaces.allocate(1, 4, 2, 3), 1);
    const mask = graph.surfaces.descriptor(1);
    clearAokanaBitmap(mask);
    mask.storage.bytes[2] = 1;
    mask.storage.written(2, 1);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const handle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [handle, 20, 40, 0, 0x80, 77, 2], 0), 0);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    sprite.setValueD8(0, 6);

    const captureCounts = () => {
      const {pointer, key} = graph.input.captureDiagnosticView();
      return [pointer.length, key.length];
    };
    const baselineCaptures = captureCounts();
    assert.equal(await invoke(0x90, 0x2c, [handle, 0, 16, 2, 2, 50, 8, 1, 1], 2), 0);
    assert.notEqual(child.process, null);
    assert.equal(child.flags & 1, 1);
    assert.deepEqual(
      captureCounts(),
      baselineCaptures.map((count) => count + 1),
    );
    tick = 125;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 24});
    assert.equal(graph.manager.redraw.pending, 1);
    tick = 250;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 32});
    tick = 500;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 36});
    tick = 1000;
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(child.flags & 1, 0);
    assert.equal(pop32(child.state), 0);
    assert.equal(pop32(child.state), 500);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 40});
    assert.equal(sprite.getBlendValue(), 77);
    assert.equal(sprite.getValueD8(0), 6);
    assert.deepEqual(captureCounts(), baselineCaptures);
    assert.equal(graph.input.keyCaptureAllowed(0), true);

    sprite.move(10, 20);
    sprite.setOffset(3, -2);
    sprite.setSecondaryOffset(-1, 4);
    assert.deepEqual(sprite.effectivePosition(), {x: 12, y: 22});
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 14;
    graph.input.pointerClientY = 22;
    assert.deepEqual(graph.input.pointerPosition(), [14, 22]);
    assert.equal(await invoke(0x90, 0x3c, [handle, 1], 0), 0);
    assert.equal(await invoke(0x90, 0x3d, [handle], 0), 1);
    assert.equal(pop32(child.state), 4);
    clearAokanaBitmap(mask);
    assert.equal(await invoke(0x90, 0x3d, [handle], 0), 1);
    assert.equal(pop32(child.state), 4);
    graph.input.pointerClientX = 16;
    assert.equal(await invoke(0x90, 0x3d, [handle], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(await invoke(0x90, 0x3c, [handle, 0xffffffff], 0), 0);
    graph.input.pointerClientX = 14;
    assert.equal(await invoke(0x90, 0x3d, [handle], 0), 1);
    assert.equal(pop32(child.state), 1);

    assert.equal(graph.surfaces.allocate(2, 8, 6, 1), 1);
    assert.equal(graph.surfaces.allocate(3, 4, 2, 1), 1);
    assert.equal(graph.surfaces.fill(2, 0x101010), 1);
    assert.equal(graph.surfaces.fill(3, 0x5a5a5a), 1);
    assert.equal(await invoke(0x90, 0xca, [2, 3], 0), 0);
    const output = graph.surfaces.snapshot(2);
    assert.ok(output);
    assert.deepEqual(
      Array.from({length: 6}, (_, y) =>
        Array.from(
          {length: 8},
          (_, x) =>
            output.storage.view.getUint32(output.offset + y * output.stride + x * 4, true) &
            0xffffff,
        ),
      ),
      Array.from({length: 6}, (_, y) =>
        Array.from({length: 8}, () => (y === 0 || y === 5 ? 0 : 0x5a5a5a)),
      ),
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(await invoke(0x90, 0x51, [handle], 0), 0);
    assert.equal(graph.manager.find('sprite', handle), null);
    for (const index of [3, 2, 1, 0]) assert.equal(graph.surfaces.release(index), 1);
  } finally {
    await fixture.close();
  }
});
