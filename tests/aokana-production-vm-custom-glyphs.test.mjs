import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted custom glyph callbacks copy graph surface slices into the shared text registry', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const glyphs = graph.windowState.textLayout.customGlyphs;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const pixels = (key) => {
    const bitmap = glyphs.snapshot(key);
    assert.ok(bitmap);
    return Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
      bitmap.storage.view.getUint8(
        bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width),
      ),
    );
  };
  try {
    assert.equal(graph.windowState.textLayout.text, graph.text);
    assert.equal(glyphs.surfaces, graph.surfaces);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x90 && secondary === 0x9e) || (primary === 0x92 && secondary === 0x98),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x90, 0x9e],
        [0x92, 0x98],
      ],
    );
    memory.globalMemory.set([0, 1, 2, 3, 10, 11, 12, 13], 0x200);
    await call(0x90, 0x14, [9, 4, 2, 3, 0x200]);
    assert.deepEqual(
      [
        graph.surfaces.snapshot(9).width,
        graph.surfaces.snapshot(9).height,
        graph.surfaces.snapshot(9).format,
      ],
      [4, 2, 3],
    );
    await call(0x90, 0x9e, [2, 9]);
    assert.equal(glyphs.count, 2);
    assert.deepEqual(pixels(0x8000f001), [0, 1, 10, 11]);
    assert.deepEqual(pixels(0x8000f002), [2, 3, 12, 13]);
    await call(0x81, 0x00, [1], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x92, 0x98, [0xf003, 9, 1, 0, 1, 2]);
    assert.equal(glyphs.count, 3);
    assert.deepEqual(pixels(0x8000f003), [1, 11]);
    await call(0x90, 0x13, [9, 0x7f]);
    assert.deepEqual(pixels(0x8000f001), [0, 1, 10, 11]);
    assert.deepEqual(pixels(0x8000f002), [2, 3, 12, 13]);
    assert.deepEqual(pixels(0x8000f003), [1, 11]);
    await call(0x90, 0x9e, [0, 0xffffffff]);
    assert.equal(glyphs.count, 0);
    await call(0x81, 0x00, [0], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x90, 0x12, [9], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
