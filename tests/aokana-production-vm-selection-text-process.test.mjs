import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted text selections draw and complete through one graph Window and shared owners', async () => {
  let tick = 0;
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
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider, performanceNow: () => tick});
  const {graph, data, child, definitions, memory, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, status = 0, pushes = 0) => {
    assert.equal(await invoke(primary, secondary, args, status), pushes);
    assert.equal(child.state.stackIndex, pushes);
  };
  const pixel = (bitmap, x, y) =>
    bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
  const captures = () => {
    const view = graph.input.captureDiagnosticView();
    return {
      pointer: view.pointer.map(({token}) => token),
      key: view.key.map(({token}) => token),
    };
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xa0 && secondary <= 0xa7,
        )
        .map(({secondary}) => secondary),
      [0xa0, 0xa4, 0xa5, 0xa6, 0xa1, 0xa7, 0xa2, 0xa3],
    );
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.windowState.textLayout.surfaces, graph.surfaces);
    assert.equal(data.graph, graph);
    assert.equal(graph.cursorMotion.input, graph.input);
    assert.equal(graph.cursorMotion.clock, graph.clock);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);

    await call(0x90, 0x0d, [0xffffffff]);
    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    await call(0xb0, 0xc1, [0x100, 1], 0, 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    await call(0x90, 0x80, [32, 32], 0, 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof AokanaWindowDisplayObject);
    await call(0x91, 0x88, [handle, font, 8, 100, 0, 0, 0]);
    await call(0x90, 0x88, [handle, 0, 0, 32, 16]);

    for (let index = 0; index < 3; index++) {
      const address = 0x120 + index * 0x10;
      memory.globalMemory.set(graph.text.encodeWide(String.fromCharCode(65 + index), 1), address);
      view.setUint32(0x180 + index * 4, address, true);
    }
    const colors = [0xff0000, 0x00ff00, 0x0000ff];
    for (let index = 0; index < 16; index++) {
      view.setUint32(0x200 + index * 4, colors[index % 3], true);
    }
    await call(0x90, 0xa7, [handle, 0x200]);
    await call(0x90, 0xa1, [handle, 3, 0x180, 2, 0, 0xffffff]);
    assert.deepEqual(
      [
        pixel(window.textBitmap, 0, 0),
        pixel(window.textBitmap, 16, 0),
        pixel(window.textBitmap, 0, 8),
      ],
      [0xfe0000, 0x00fe00, 0x0000fe],
    );
    assert.equal(pixel(window.compositionBitmap, 16, 0), 0x00fe00);
    assert.equal(graph.device.isPresent(), false);
    const initialCaptures = captures();

    await call(0x90, 0xa4, [0xff0000, 0xffff00]);
    await call(0x90, 0xa5, [50]);
    await call(0x90, 0xa6, [0, 0, 0, 0]);
    await call(0x90, 0xa0, [handle, 3, 0x180, 2, 0, 0xffffff, 0, 1], 2);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.compositionBitmap, 0, 0), 0xfe0000);
    tick = 50;
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.compositionBitmap, 0, 0), 0xfefe00);
    graph.input.recordKeyDown(13);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual(captures(), initialCaptures);

    for (const [id, color] of [
      [1, 0xff00ffff],
      [2, 0xffff00ff],
    ]) {
      await call(0x90, 0x11, [id, 2, 2, 2]);
      await call(0x90, 0x13, [id, color]);
    }
    const extended = (secondary, selected) =>
      call(0x90, secondary, [handle, 3, 0x180, 2, 0, 0xffffff, selected, 1, 1, 4, 0, 2, 2, 0], 2);
    graph.input.pointerAvailable = true;
    graph.input.touchPositions = [[18, 1]];
    await extended(0xa2, 1);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(window.overlayRectangle(1), {left: 20, top: 0, right: 21, bottom: 1});
    assert.deepEqual(window.overlayRectangle(2), {left: 22, top: 0, right: 23, bottom: 1});
    assert.deepEqual(
      [pixel(window.compositionBitmap, 20, 0), pixel(window.compositionBitmap, 22, 0)],
      [0x00ffff, 0xff00ff],
    );
    graph.input.recordKeyDown(50);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual(captures(), initialCaptures);

    tick = 1000;
    await extended(0xa3, 2);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(window.overlayRectangle(1), {left: 4, top: 8, right: 5, bottom: 9});
    assert.deepEqual(window.overlayRectangle(2), {left: 6, top: 8, right: 7, bottom: 9});
    assert.deepEqual(
      [pixel(window.compositionBitmap, 4, 8), pixel(window.compositionBitmap, 6, 8)],
      [0x00ffff, 0xff00ff],
    );
    assert.equal(pixel(window.compositionBitmap, 0, 8), 0xfe0000);
    for (let step = 1; step < 20; step++) {
      tick = 1000 + step * 50;
      assert.equal(await child.pollProcess(false), 0);
    }
    assert.equal(pixel(window.compositionBitmap, 0, 8), 0xfefe00);
    tick = 2000;
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 2);
    assert.equal(pop32(child.state), 2);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual(captures(), initialCaptures);

    await call(0x90, 0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
    for (const id of [2, 1]) {
      await call(0x90, 0x12, [id], 0, 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});

test('mounted graph selects the complete browser font selection family', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.deepEqual(
      fixture.definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xa0 && secondary <= 0xa7,
        )
        .map(({secondary}) => secondary),
      [0xa0, 0xa4, 0xa5, 0xa6, 0xa1, 0xa7, 0xa2, 0xa3],
    );
  } finally {
    await fixture.close();
  }
});
