import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM writes linear and radial format-six vector-distance maps', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, fragments, invoke} = fixture;
  const triples = (index) => {
    const bitmap = graph.surfaces.snapshot(index);
    assert.ok(bitmap);
    assert.equal(bitmap.format, 6);
    assert.equal(bitmap.bytesPerPixel, 6);
    return Array.from({length: bitmap.width * bitmap.height}, (_, position) => {
      const offset =
        bitmap.offset +
        Math.floor(position / bitmap.width) * bitmap.stride +
        (position % bitmap.width) * 6;
      return [
        bitmap.storage.view.getInt16(offset, true),
        bitmap.storage.view.getInt16(offset + 2, true),
        bitmap.storage.view.getInt16(offset + 4, true),
      ];
    });
  };
  const call = async (primary, secondary, args, pushed = false) => {
    assert.equal(await invoke(primary, secondary, args, 0), Number(pushed));
    const result = pushed ? pop32(child.state) : undefined;
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  try {
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && [0x10, 0x11].includes(secondary))
        .map(({secondary}) => secondary),
      [0x10, 0x11],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    await call(0x90, 0x11, [0, 2, 2, 6]);
    await call(0x92, 0x11, [0, 0]);
    assert.deepEqual(triples(0), [
      [32767, 0, 0],
      [32767, 0, 0],
      [32767, 0, 4],
      [32767, 0, 4],
    ]);
    await call(0x92, 0x11, [0, 1]);
    assert.deepEqual(triples(0), [
      [0, 32767, 0],
      [0, 32767, 4],
      [0, 32767, 0],
      [0, 32767, 4],
    ]);

    await call(0x90, 0x11, [1, 1, 1, 6]);
    await call(0x92, 0x10, [1, 0, -1, 0, 0]);
    assert.deepEqual(triples(1), [[32766, 0, 4]]);
    await call(0x90, 0x11, [2, 3, 1, 6]);
    await call(0x92, 0x10, [2, 0, -1, 0, 0]);
    assert.deepEqual(
      triples(2).map((triple) => triple[2]),
      [4, 8, 12],
    );

    for (const index of [2, 1, 0]) assert.equal(await call(0x90, 0x12, [index], true), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
