import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted text producers feed shared result callbacks and local pixels', async () => {
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
      const size = Math.abs(parameters.height);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        cssFamily: parameters.face,
        averageWidth: 0,
        ascent: size,
        emSize: size,
        horizontalScale: 1,
        abc() {
          return [-1.25, 4.75, 0.5];
        },
        extent() {
          return size / 2;
        },
        rasterText(_text, width, height) {
          const bytes = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) bytes.fill(255, y * width, y * width + size / 2);
          return {stride: width, bytes};
        },
        rasterMonochrome() {
          assert.fail('ordinary surface draw must use the configured cache');
        },
        outline() {
          assert.fail('ordinary surface draw must use the configured cache');
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, memory, child, definitions, invoke} = fixture;
  const state = graph.windowState.textLayout;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushes = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushes);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(state.surfaces, graph.surfaces);
    assert.equal(state.surfaces.fonts, graph.fonts);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x90 && secondary === 0x0d) ||
            (primary === 0x91 && [0x88, 0x91, 0x99, 0x9b, 0x9c].includes(secondary)) ||
            (primary === 0x92 && [0x94, 0x95, 0x99, 0x9b, 0x9e, 0x9f].includes(secondary)),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x90, 0x0d],
        [0x91, 0x88],
        [0x91, 0x99],
        [0x91, 0x9b],
        [0x91, 0x91],
        [0x91, 0x9c],
        [0x92, 0x94],
        [0x92, 0x95],
        [0x92, 0x99],
        [0x92, 0x9b],
        [0x92, 0x9e],
        [0x92, 0x9f],
      ],
    );
    assert.equal(graph.manager.configureDescriptor(64, 32, 2, 64 * 32), 1);
    await call(0x90, 0x0d, [0xffffffff]);
    assert.equal(graph.fonts.rasterSettings.quality, -1);
    await call(0x90, 0x11, [7, 20, 12, 2]);
    assert.ok(graph.surfaces.snapshot(7));

    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('A<l>B</l>', 1), 0x200);
    memory.globalMemory.set(graph.text.encodeWide('A', 1), 0x240);
    memory.globalMemory.set(graph.text.encodeWide('AB', 1), 0x280);
    await call(0xb0, 0xc1, [0x100, 1], 1);
    const registeredFont = pop32(child.state);
    assert.equal(registeredFont, 2);
    await call(0x91, 0x9a, [0x80000009, 1]);
    await call(0x92, 0x9f, [0x112233]);
    await call(0x91, 0x9c, [7, 1, 2, 0x200, 0, 0, registeredFont, 8, 100, 0, 0, 0, 0, 0xabcdef], 1);
    const lineId = pop32(child.state);
    assert.equal(lineId, 1);
    assert.deepEqual(state.lineHeightLayouts.get(lineId), [8]);
    assert.deepEqual(state.surfaceCursor, {x: 9, y: 2});
    assert.equal(state.currentInlineColor, 0xabcdef);
    assert.deepEqual(
      state.linkRegions.map(({text, x, y}) => [Array.from(text), x, y]),
      [[[66], 5, 2]],
    );
    const surface = graph.surfaces.snapshot(7);
    assert.ok(surface);
    const pixel = (x, y) =>
      surface.storage.view.getUint32(surface.offset + y * surface.stride + x * 4, true);
    assert.equal(pixel(1, 2), 0xffabcdef);
    assert.equal(pixel(5, 2), 0xff112233);
    assert.equal(pixel(0, 0), 0);
    assert.ok(created.length >= 1);
    assert.ok(created.every(({face}) => face === 'Synthetic'));

    const createdBeforeMetrics = created.length;
    await call(0x92, 0x99, [0x500, 0x540, 0x280, registeredFont, 8, 100, 0], 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(view.getUint32(0x540, true), 2);
    assert.deepEqual(
      Array.from({length: 6}, (_, index) => view.getInt32(0x500 + index * 4, true)),
      [0, 5, 1, 0, 5, 1],
    );
    await call(0x91, 0x9b, [0x580, 0x280, registeredFont, 8, 100, 0, 0], 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(view.getInt32(0x580, true), 8);
    assert.equal(created.length, createdBeforeMetrics);

    await call(0x92, 0x94, [0, lineId], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x92, 0x94, [0x300, lineId], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(view.getUint32(0x300, true), 8);
    await call(0x92, 0x9b, [0x340, 0x100]);
    assert.deepEqual([view.getInt32(0x340, true), view.getInt32(0x344, true)], [9, 2]);
    await call(0x92, 0x9b, [0x350, 0x101]);
    assert.equal(view.getUint32(0x350, true), 0xabcdef);
    await call(0x92, 0x9e, [0x380], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(memory.globalMemory[0x380], 66);
    assert.ok(memory.globalMemory.subarray(0x381, 0x3e0).every((value) => value === 0));
    assert.ok(memory.globalMemory.subarray(0x3e0, 0x3f8).every((value) => value === 0));
    assert.deepEqual([view.getInt32(0x3f8, true), view.getInt32(0x3fc, true)], [5, 2]);

    await call(0x91, 0x99, [2], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(state.proportionalSideBearing, 32768);
    await call(
      0x91,
      0x9c,
      [7, 20, 2, 0x240, 0, 0, registeredFont, 8, 100, 1, 0, 0, 0, 0xabcdef],
      1,
    );
    const proportionalLineId = pop32(child.state);
    assert.equal(proportionalLineId, 2);
    assert.deepEqual(state.surfaceCursor, {x: 24, y: 2});
    assert.equal(pixel(20, 2), 0);
    assert.equal(pixel(22, 2), 0xffabcdef);

    await call(0x90, 0x80, [32, 20], 1);
    const windowHandle = pop32(child.state);
    const window = graph.manager.find('window', windowHandle);
    assert.ok(window);
    await call(0x91, 0x88, [windowHandle, registeredFont, 8, 100, 0, 0, 0]);
    assert.equal(window.fontSize, 8);
    assert.equal(window.lineExtent, 8);
    await call(0x92, 0x95, [windowHandle], 1);
    assert.equal(pop32(child.state), 8);
    await call(0x91, 0x91, [windowHandle, 0x240, 0x445566, 0, 0]);
    assert.deepEqual(window.getTextCursor(), {x: 4, y: 0});
    assert.equal(
      window.textBitmap.storage.view.getUint32(window.textBitmap.offset, true),
      0xff445566,
    );
    assert.equal(
      window.compositionBitmap.storage.view.getUint32(window.compositionBitmap.offset, true),
      0xff445566,
    );
    await call(0x90, 0x81, [windowHandle]);
    assert.equal(graph.manager.find('window', windowHandle), null);
    await call(0x90, 0x12, [7], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
