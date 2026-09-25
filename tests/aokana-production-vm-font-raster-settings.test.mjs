import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted font raster settings change ordinary upright and italic glyph layout', async () => {
  const created = [];
  const fontProvider = {
    async queryPitch() {
      return null;
    },
    async queryCharset() {
      return 1;
    },
    async enumerate() {
      return [];
    },
    async loadResource() {
      return null;
    },
    unloadResource() {
      return false;
    },
    async create(parameters) {
      created.push(parameters);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        cssFamily: parameters.face,
        averageWidth: 0,
        ascent: 8,
        emSize: 8,
        horizontalScale: 1,
        abc() {
          return [0, 4, 0];
        },
        extent() {
          return 4;
        },
        rasterText(_value, width, height) {
          return {stride: width, bytes: new Uint8Array(width * height).fill(255)};
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, child, definitions, memory, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushes = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushes);
    assert.equal(child.state.stackIndex, pushes);
    assert.equal(child.process, null);
  };
  const pixel = async (surface, x) => {
    await call(0x92, 0x17, [0x280, surface, x, 0], 1);
    assert.equal(pop32(child.state), 0);
    return view.getUint32(0x280, true) & 0xffffff;
  };
  const draw = async (surface, source, font, expectedSecondX, expectedCursor) => {
    await call(0x91, 0x9c, [surface, 0, 0, source, 0, 0, font, 8, 100, 0, 0, 0, 0, 0x445566], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x92, 0x9b, [0x240, 0x100]);
    assert.deepEqual([view.getInt32(0x240, true), view.getInt32(0x244, true)], [expectedCursor, 0]);
    assert.equal(await pixel(surface, 0), 0x445566);
    assert.equal(await pixel(surface, expectedSecondX), 0x445566);
    assert.equal(await pixel(surface, 30), 0);
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x0e, 0x0f].includes(secondary))
        .map(({secondary}) => secondary),
      [0x0e, 0x0f],
    );
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.windowState.textLayout.surfaces, graph.surfaces);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(32, 16, 2, 32 * 16), 1);

    await call(0x90, 0x0d, [0xffffffff]);
    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('AA', 1), 0x180);
    memory.globalMemory.set(graph.text.encodeWide('<i>AA</i>', 1), 0x1c0);
    await call(0xb0, 0xc1, [0x100, 0], 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    for (const surface of [1, 2]) {
      await call(0x90, 0x11, [surface, 32, 16, 2]);
      await call(0x90, 0x13, [surface, 0]);
    }

    await call(0x91, 0x0e, [0x100, 65536, 65536, 0, 0]);
    await call(0x91, 0x0f, [font, 8, 100, 0, 3, 5]);
    await draw(1, 0x180, font, 7, 14);
    await draw(2, 0x1c0, font, 9, 18);
    assert.ok(created.length >= 1);
    assert.ok(created.every(({face}) => face === 'Synthetic'));
    assert.equal(graph.device.isPresent(), false);

    for (const surface of [2, 1]) {
      await call(0x90, 0x12, [surface], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted graph selects browser font raster settings', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.deepEqual(
      fixture.definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x0e, 0x0f].includes(secondary))
        .map(({secondary}) => secondary),
      [0x0e, 0x0f],
    );
  } finally {
    await fixture.close();
  }
});
