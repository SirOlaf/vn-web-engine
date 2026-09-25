import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted registered surface text draws and reports multiline metrics through one font cache', async () => {
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
          const bytes = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) bytes.fill(255, y * width, y * width + 4);
          return {stride: width, bytes};
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, child, definitions, memory, invoke} = fixture;
  const output = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushes = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushes);
    assert.equal(child.state.stackIndex, pushes);
    assert.equal(child.process, null);
  };
  const pixel = async (surface, x, y) => {
    await call(0x92, 0x17, [0x300, surface, x, y], 1);
    assert.equal(pop32(child.state), 0);
    return output.getUint32(0x300, true) & 0xffffff;
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x92 && [0x1c, 0x1d, 0x1e].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x1c, 0x1d, 0x1e],
    );
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.surfaces.compositor, graph.compositor);
    assert.equal(graph.surfaces.allocator, graph.allocator);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);

    await call(0x90, 0x0d, [0xffffffff]);
    memory.globalMemory.set(graph.text.encodeWide('SurfaceSynthetic', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('A\nBC', 1), 0x180);
    memory.globalMemory.set(graph.text.encodeWide('ABCDE', 1), 0x200);
    await call(0xb0, 0xc1, [0x100, 0], 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    for (const [id, width, height] of [
      [1, 24, 24],
      [2, 16, 32],
    ]) {
      await call(0x90, 0x11, [id, width, height, 1]);
      await call(0x90, 0x13, [id, 0]);
    }

    await call(0x92, 0x1c, [1, 1, 1, 0x180, font, 8, 100, 0, 0, 0xff0000], 1);
    assert.equal(pop32(child.state), 8);
    for (const [x, y, color] of [
      [1, 1, 0xfe0000],
      [4, 8, 0xfe0000],
      [5, 1, 0],
      [8, 9, 0xfe0000],
      [9, 9, 0],
    ]) {
      assert.equal(await pixel(1, x, y), color);
    }

    await call(0x92, 0x1d, [2, 0, 0, 0x200, font, 8, 100, 0, 0, 0x00ff00, 50], 1);
    assert.equal(pop32(child.state), 3);
    for (const y of [0, 7, 12, 19, 24, 31]) assert.equal(await pixel(2, 0, y), 0x00fe00);
    for (const y of [8, 11, 20, 23]) assert.equal(await pixel(2, 0, y), 0);
    assert.equal(await pixel(2, 7, 0), 0x00fe00);
    assert.equal(await pixel(2, 8, 0), 0);
    assert.equal(await pixel(2, 4, 24), 0);
    assert.equal(created.length, 1);
    assert.equal(created[0].face, 'SurfaceSynthetic');
    assert.equal(graph.device.isPresent(), false);

    for (const id of [2, 1]) {
      await call(0x90, 0x12, [id], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted graph selects registered surface text with browser fonts', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.deepEqual(
      fixture.definitions
        .filter(
          ({primary, secondary}) => primary === 0x92 && [0x1c, 0x1d, 0x1e].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x1c, 0x1d, 0x1e],
    );
  } finally {
    await fixture.close();
  }
});
