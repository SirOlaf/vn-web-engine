import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM timing and displacement callbacks share clock, counter, frame history, and CRT stream', async () => {
  let tick = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => tick});
  const {graph, core, memory, child, definitions, fragments, invoke} = fixture;
  const call = async (primary, secondary, args, pushed = false) => {
    assert.equal(await invoke(primary, secondary, args, 0), Number(pushed));
    const result = pushed ? pop32(child.state) : undefined;
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  try {
    assert.equal(graph.frames.metrics.clock, graph.clock);
    assert.equal(graph.particles.random, graph.particleRandom);
    assert.equal(graph.particles.clock, graph.clock);
    assert.equal(graph.particles.processing, graph.resource.processing);
    assert.equal(graph.particles.processing.allocator, graph.allocator);
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x80 && secondary <= 5)
        .map(({secondary}) => secondary),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x10, 0x11].includes(secondary))
        .map(({secondary}) => secondary),
      [0x10, 0x11],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    tick = 7;
    core.frameHistory.record(Number(graph.clock.read()));
    tick = 11;
    core.frameHistory.record(Number(graph.clock.read()));
    const words = new DataView(memory.globalMemory.buffer);
    assert.equal(await call(0x80, 0x03, [0x300, 2], true), 1);
    assert.deepEqual([words.getUint32(0x300, true), words.getUint32(0x304, true)], [4, 7]);
    assert.equal(await call(0x80, 0x04, [], true), 11);
    assert.equal(await call(0x80, 0x05, [0x320], true), 1);
    assert.equal(words.getBigInt64(0x320, true), 11000000n);

    await call(0x80, 0x00, [1]);
    assert.equal(await call(0x80, 0x01, [], true), 41);
    await call(0x80, 0x00, [1]);
    assert.equal(await call(0x80, 0x02, [1000], true), 286);
    await call(0x80, 0x00, [1]);

    for (const [index, format] of [
      [0, 4],
      [2, 1],
    ])
      await call(0x90, 0x11, [index, 2, 2, format]);
    memory.globalMemory.set(
      [0x30, 0x20, 0x10, 0x60, 0x50, 0x40, 0x90, 0x80, 0x70, 0xc0, 0xb0, 0xa0],
      0x400,
    );
    await call(0x90, 0x14, [1, 2, 2, 1, 0x400]);
    await call(0x90, 0x13, [2, 0]);
    await call(0x91, 0x10, [0, 1, 0, 1, 1]);
    const map = graph.surfaces.snapshot(0);
    const vectors = () =>
      Array.from({length: 4}, (_, index) => {
        const offset = map.offset + Math.floor(index / 2) * map.stride + (index % 2) * 4;
        return [
          map.storage.view.getInt16(offset, true),
          map.storage.view.getInt16(offset + 2, true),
        ];
      });
    assert.deepEqual(vectors(), [
      [16, 0],
      [8, 0],
      [16, -8],
      [8, -8],
    ]);
    await call(0x90, 0x1a, [2, 1, 0, -1, 256, 0]);
    const output = graph.surfaces.snapshot(2);
    assert.deepEqual(
      Array.from({length: 4}, (_, index) =>
        bitmapRead32(
          output,
          output.offset + Math.floor(index / 2) * output.stride + (index % 2) * 4,
        ),
      ),
      [0x405060, 0x405060, 0x405060, 0x405060],
    );
    await call(0x91, 0x11, [0, 1]);
    assert.deepEqual(vectors(), [
      [1, 1],
      [-1, 1],
      [0, 1],
      [-1, 0],
    ]);
    assert.equal(await call(0x80, 0x01, [], true), 2995);

    for (const index of [2, 1, 0]) assert.equal(await call(0x90, 0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
