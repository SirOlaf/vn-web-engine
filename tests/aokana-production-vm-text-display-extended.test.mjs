import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted extended horizontal Window messages use bound layout timing and notifications', async () => {
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
  const captures = () => {
    const view = graph.input.captureDiagnosticView();
    return {
      pointer: view.pointer.map(({token}) => token),
      key: view.key.map(({token}) => token),
    };
  };
  const pixel = (bitmap, x) => bitmapRead32(bitmap, bitmap.offset + x * 4) & 0xffffff;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && [0x90, 0x92, 0x98].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x98, 0x90, 0x92],
    );
    assert.equal(data.procedureState, fixture.core.procedureState);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.windowState.textLayout.surfaces, graph.surfaces);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    graph.input.foreground = true;

    await call(0x90, 0x0d, [0xffffffff]);
    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('A', 1), 0x180);
    memory.globalMemory.set(graph.text.encodeWide('B', 1), 0x1a0);
    await call(0xb0, 0xc1, [0x100, 1], 0, 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    await call(0x90, 0x80, [32, 16], 0, 1);
    const handle = pop32(child.state);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof BurikoWindowDisplayObject);
    await call(0x91, 0x88, [handle, font, 8, 100, 0, 0, 0]);
    await call(0x91, 0x98, [2, 4, 0, 25, 0, 0]);
    assert.equal(graph.windowState.textLayout.field1C9100, 2);
    assert.equal(graph.windowState.textLayout.field1C90E8, 4);
    const initialCaptures = captures();
    const firstArgs = [handle, 0x180, 0xffffff, 0, 0, 1, 1, 0, 0, 0];
    await call(0x91, 0x90, firstArgs, 2);
    assert.ok(child.process);
    assert.equal(graph.input.keyCaptureAllowed(1), false);
    assert.notDeepEqual(captures(), initialCaptures);
    assert.deepEqual(window.getTextCursor(), {x: 4, y: 0});
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.textBitmap, 0), 0);
    assert.deepEqual(graph.notifications.take(), {type: 0x30000002, value1: 0, value2: 0});
    tick = 2;
    assert.equal(await child.pollProcess(false), 0);
    const firstPartial = pixel(window.textBitmap, 0);
    assert.notEqual(firstPartial, 0);
    tick = 3;
    assert.equal(await child.pollProcess(false), 0);
    const firstComplete = pixel(window.textBitmap, 0);
    assert.notEqual(firstComplete, firstPartial);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(graph.notifications.take(), null);

    const secondArgs = [handle, 0x1a0, 0xffffff, 0, 0, 0, 1, 1, 0, 0, 0];
    await call(0x91, 0x92, secondArgs, 2);
    assert.ok(child.process);
    assert.equal(graph.input.keyCaptureAllowed(1), false);
    assert.deepEqual(window.getTextCursor(), {x: 8, y: 0});
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.textBitmap, 0), firstComplete);
    assert.equal(pixel(window.textBitmap, 4), 0);
    assert.deepEqual(graph.notifications.take(), {type: 0x30000002, value1: 0, value2: 0});
    tick = 5;
    assert.equal(await child.pollProcess(false), 0);
    const secondPartial = pixel(window.textBitmap, 4);
    assert.notEqual(secondPartial, 0);
    tick = 7;
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(pixel(window.textBitmap, 0), firstComplete);
    assert.notEqual(pixel(window.textBitmap, 4), secondPartial);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(pop32(child.state), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(graph.notifications.take(), null);
    assert.equal(graph.device.isPresent(), false);
    await call(0x90, 0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
  } finally {
    await fixture.close();
  }
});

test('mounted graph selects extended Window messages and layout timing with browser fonts', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.deepEqual(
      fixture.definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && [0x90, 0x92, 0x98].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x98, 0x90, 0x92],
    );
  } finally {
    await fixture.close();
  }
});
