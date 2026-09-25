import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted named font transform changes shared cached draw and measurement spacing', async () => {
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
        averageWidth: 8,
        ascent: 8,
        emSize: 8,
        horizontalScale: 1,
        abc() {
          return [0.25, 6, 0.75];
        },
        extent() {
          return 8;
        },
        rasterText(_value, width, height) {
          const bytes = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) {
            bytes.fill(255, y * width, y * width + Math.min(8, width));
          }
          return {stride: width, bytes};
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
    await call(0x92, 0x17, [0x300, surface, x, 0], 1);
    assert.equal(pop32(child.state), 0);
    return view.getUint32(0x300, true) & 0xffffff;
  };
  const drawAndMeasure = async (surface, font, expectedCursor, glyphX) => {
    await call(0x91, 0x9c, [surface, 0, 0, 0x180, 0, 0, font, 8, 100, 0, 0, 0, 0, 0x123456], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x92, 0x9b, [0x200, 0x100]);
    assert.deepEqual([view.getInt32(0x200, true), view.getInt32(0x204, true)], [expectedCursor, 0]);
    await call(0x91, 0x9b, [0x220, 0x180, font, 8, 100, 0, 0], 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(view.getInt32(0x220, true), expectedCursor);
    assert.equal(await pixel(surface, 0), 0x123456);
    assert.equal(await pixel(surface, glyphX), 0x123456);
    assert.equal(await pixel(surface, expectedCursor), 0);
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && [0x0e, 0x0f].includes(secondary))
        .map(({secondary}) => secondary),
      [0x0e, 0x0f],
    );
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
    // Two CP932 private-use, full-width glyphs produce the standalone 8-pixel advance.
    memory.globalMemory.set([0xef, 0x40, 0xef, 0x41, 0], 0x180);
    [65536, 65536, 0, 0, 0].forEach((value, index) =>
      view.setInt32(0x140 + index * 4, value, true),
    );
    await call(0xb0, 0xc1, [0x100, 0], 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    for (const surface of [1, 2]) {
      await call(0x90, 0x11, [surface, 32, 16, 2]);
      await call(0x90, 0x13, [surface, 0]);
    }

    await call(0x92, 0x0e, [0x100, 4, 0x140]);
    await drawAndMeasure(1, font, 16, 8);
    assert.equal(await pixel(1, 15), 0x123456);

    await call(0x92, 0x0f, [0x100, 32768]);
    await drawAndMeasure(2, font, 24, 12);
    assert.equal(await pixel(2, 8), 0);
    assert.equal(await pixel(2, 11), 0);
    assert.equal(await pixel(2, 19), 0x123456);
    assert.equal(created.length, 1);
    assert.equal(created[0].face, 'Synthetic');
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

test('mounted graph selects named font transforms with browser fonts', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.deepEqual(
      fixture.definitions
        .filter(({primary, secondary}) => primary === 0x92 && [0x0e, 0x0f].includes(secondary))
        .map(({secondary}) => secondary),
      [0x0e, 0x0f],
    );
  } finally {
    await fixture.close();
  }
});
