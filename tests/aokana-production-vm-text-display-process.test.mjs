import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted Window message uses ordinary timed glyph phases and restores input capture', async () => {
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
          return [0, size / 2, 0];
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
        .filter(({primary, secondary}) => primary === 0x90 && secondary === 0x90)
        .map(({secondary}) => secondary),
      [0x90],
    );
    assert.equal(data.procedureState, fixture.core.procedureState);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.windowState.textLayout.text, graph.text);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    graph.input.foreground = true;

    await call(0x90, 0x0d, [0xffffffff]);
    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    memory.globalMemory.set([0xef, 0x40, 12, 0xef, 0x41, 0], 0x180);
    await call(0xb0, 0xc1, [0x100, 1], 0, 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    await call(0x90, 0x80, [32, 16], 0, 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof AokanaWindowDisplayObject);
    await call(0x91, 0x88, [handle, font, 8, 100, 0, 0, 0]);
    await call(0x90, 0x96, [2, 10]);
    const initialCaptures = captures();
    await call(0x90, 0x90, [handle, 0x180, 0xffffff, 0, 1, 1], 2);
    assert.ok(child.process);
    assert.equal(graph.input.keyCaptureAllowed(1), false);
    assert.notDeepEqual(captures(), initialCaptures);

    assert.equal(await child.pollProcess(false), 0);
    assert.notEqual(window.overlayRectangle(0), null);
    assert.equal(pixel(window.textBitmap, 0, 0), 0);
    tick = 50;
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(window.overlayRectangle(0), null);
    assert.notEqual(pixel(window.textBitmap, 0, 0), 0);
    assert.deepEqual(window.getTextCursor(), {x: 8, y: 0});
    tick = 100;
    assert.equal(await child.pollProcess(false), 0);
    tick = 110;
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.textBitmap, 0, 0), 0);
    assert.deepEqual(window.getTextCursor(), {x: 0, y: 0});
    tick = 120;
    assert.equal(await child.pollProcess(false), 0);
    assert.notEqual(window.overlayRectangle(0), null);
    tick = 170;
    assert.equal(await child.pollProcess(false), 0);
    assert.notEqual(pixel(window.textBitmap, 0, 0), 0);
    tick = 220;
    assert.equal(await child.pollProcess(false), 0);
    graph.input.recordKeyDown(13);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(graph.input.keyCaptureAllowed(1), true);
    assert.equal(graph.device.isPresent(), false);
    await call(0x90, 0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
  } finally {
    await fixture.close();
  }
});

test('mounted graph without a selected font provider omits Window message process', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x90 && secondary === 0x90),
      false,
    );
  } finally {
    await fixture.close();
  }
});
