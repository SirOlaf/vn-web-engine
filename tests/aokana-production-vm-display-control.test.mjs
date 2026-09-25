import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM display and coordinate controls update one graph Sprite through scheduled child processes', async () => {
  let tick = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => tick});
  const {graph, child, memory, definitions, invoke} = fixture;
  const expectedSlots = [0x20, 0x21, 0x22, 0x23, 0x24, 0x28, 0x29];
  const start = async (slot, args) => {
    assert.equal(await invoke(0x90, slot, args, 2), 0);
    assert.notEqual(child.process, null);
    assert.equal(child.flags & 1, 1);
  };
  const finish = (status, metric) => {
    assert.equal(child.process, null);
    assert.equal(child.flags & 1, 0);
    assert.equal(pop32(child.state), status);
    assert.equal(pop32(child.state), metric);
    assert.equal(child.state.stackIndex, 0);
  };
  try {
    assert.equal(graph.input.usesClock(graph.clock), true);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && expectedSlots.includes(secondary))
        .map(({secondary}) => secondary),
      expectedSlots,
    );
    assert.equal(graph.surfaces.allocate(0, 4, 4, 2), 1);
    assert.equal(graph.surfaces.fill(0, 0xff204060), 1);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const handle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [handle, 0, 0, 0, 0x80, 0, 7], 0), 0);
    const sprite = graph.manager.find('sprite', handle);
    assert.ok(sprite);
    assert.deepEqual(sprite.position(), {x: 0, y: 0});

    await start(0x20, [handle, 64, 100, 60, 0, 1]);
    tick = 50;
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(sprite.getBlendValue(), 32);
    assert.equal(graph.manager.redraw.pending, 1);
    tick = 100;
    assert.equal(await child.pollProcess(false), 1);
    finish(0, 20);

    await start(0x21, [handle, 100, 80, 4, 128, 100, 60, 0, 1]);
    tick = 150;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 25, y: 20});
    assert.equal(sprite.getBlendValue(), 96);
    tick = 200;
    assert.equal(await child.pollProcess(false), 1);
    finish(0, 20);

    await start(0x22, [handle, 64, 100, 50, 1, 0, 1]);
    for (let step = 1; step <= 5; step++) {
      tick = 200 + step * 20;
      assert.equal(await child.pollProcess(false), Number(step === 5));
    }
    finish(0, 50);
    assert.equal(sprite.getBlendValue(), 64);

    const captureCounts = () => {
      const {pointer, key} = graph.input.captureDiagnosticView();
      return [pointer.length, key.length];
    };
    const baselineCaptures = captureCounts();
    await start(0x23, [handle, 200, 160, 6, 32, 100, 50, 1, 1, 1]);
    assert.deepEqual(
      captureCounts(),
      baselineCaptures.map((count) => count + 1),
    );
    tick = 320;
    assert.equal(await child.pollProcess(false), 0);
    child.process.enqueueMessage({code: 1, value1: 0, value2: 0});
    assert.equal(await child.pollProcess(false), 1);
    finish(1, 20);
    assert.deepEqual(sprite.position(), {x: 200, y: 160});
    assert.deepEqual(captureCounts(), baselineCaptures);
    assert.equal(graph.input.keyCaptureAllowed(0), true);

    await start(0x24, [handle, 250, 200, 300, 160, 0, 0, 100, 50, 0, 1, 1]);
    assert.deepEqual(
      captureCounts(),
      baselineCaptures.map((count) => count + 1),
    );
    tick = 360;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 240, y: 198});
    graph.input.recordKeyDown(13);
    assert.equal(await child.pollProcess(false), 1);
    finish(1, 400);
    assert.deepEqual(sprite.position(), {x: 300, y: 160});
    assert.deepEqual(captureCounts(), baselineCaptures);
    assert.equal(graph.input.keyCaptureAllowed(0), true);

    sprite.setValueD8(0, 4);
    await start(0x28, [handle, 380, 240, 0, 128, 4, 12, 100, 50, 0, 0, 1]);
    tick = 410;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 340, y: 200});
    assert.equal(sprite.getBlendValue(), 32);
    assert.equal(sprite.getValueD8(1), 8 << 16);
    tick = 460;
    assert.equal(await child.pollProcess(false), 1);
    finish(0, 20);
    assert.equal(sprite.getValueD8(1), 12 << 16);
    assert.equal(sprite.getBlendValue(), 128);

    sprite.setCoordinates(0, 0, 0);
    sprite.sortMode = 1;
    sprite.coordinateRounding = 0;
    sprite.setValueD8(0, 2);
    sprite.setBlendValue(0);
    graph.manager.lists.resort(sprite);
    const points = new DataView(memory.globalMemory.buffer);
    points.setInt32(0x300, 100 << 16, true);
    points.setInt32(0x304, 80 << 16, true);
    points.setInt32(0x308, 32 << 16, true);
    points.setUint32(0x30c, 0x12345678, true);
    await start(0x29, [handle, 1, 0x300, 0, 128, 0x80000000, 10, 100, 50, 0, 0, 1]);
    tick = 485;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.coordinates(), {x: 25 << 16, y: 20 << 16, z: 8 << 16});
    assert.equal(sprite.getBlendValue(), 64);
    assert.equal(sprite.getValueD8(1), 4 << 16);
    assert.equal(
      graph.manager.lists.snapshot(false).find(({object}) => object === sprite).key,
      sprite.sortKey(),
    );
    tick = 510;
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(sprite.coordinates(), {x: 50 << 16, y: 40 << 16, z: 16 << 16});
    assert.equal(sprite.getBlendValue(), 128);
    tick = 560;
    assert.equal(await child.pollProcess(false), 1);
    finish(0, 30);
    assert.deepEqual(sprite.coordinates(), {x: 100 << 16, y: 80 << 16, z: 32 << 16});
    assert.equal(sprite.getValueD8(1), 10 << 16);

    assert.equal(await invoke(0x90, 0x51, [handle], 0), 0);
    assert.equal(graph.manager.find('sprite', handle), null);
    assert.equal(graph.surfaces.release(0), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
