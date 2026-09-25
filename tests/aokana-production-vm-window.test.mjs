import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM binds Window lifecycle and capture to its graph', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0x80 && secondary <= 0x89,
        )
        .map(({secondary}) => secondary)
        .sort((left, right) => left - right),
      [0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89],
    );
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.windowState.textLayout.surfaces, graph.surfaces);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.fonts.text, graph.text);
    assert.equal(graph.fontProvider, null);
    assert.equal(
      definitions.some(({primary, secondary}) => primary === 0x90 && secondary === 0x0d),
      false,
    );
    assert.equal(
      definitions.some(
        ({primary, secondary}) => primary === 0x91 && (secondary === 0x91 || secondary === 0x9c),
      ),
      false,
    );
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && secondary >= 0x88 && secondary <= 0x8e,
        )
        .map(({secondary}) => secondary),
      [0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e],
    );
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x92 && secondary >= 0x88 && secondary <= 0x8e,
        )
        .map(({secondary}) => secondary),
      [0x88, 0x89, 0x8a, 0x8c, 0x8d, 0x8e],
    );
    const previousCompositorFormat = graph.compositor.defaultFormat;
    graph.compositor.defaultFormat = 1;
    assert.equal(graph.surfaces.allocate(0, 64, 32, 1), 1);
    assert.equal(graph.surfaces.fill(0, 0x224466), 1);
    assert.equal(await invoke(0x90, 0x80, [64, 32], 0), 1);
    const windowHandle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const windowObject = graph.manager.find('window', windowHandle);
    assert.ok(windowObject);
    const callWindow = async (secondary, args) => {
      assert.equal(await invoke(0x90, secondary, args, 0), 0);
    };
    await callWindow(0x86, [windowHandle, 123, 124, 0]);
    await callWindow(0x84, [windowHandle, 1]);
    await callWindow(0x85, [windowHandle, 11, 13, 1, 64, 200, 3]);
    assert.deepEqual(windowObject.position(), {x: 11, y: 13});
    assert.deepEqual(
      [windowObject.blendMode, windowObject.blendValue, windowObject.layer],
      [1, 64, 3],
    );
    await callWindow(0x82, [windowHandle, 1]);
    await callWindow(0x87, [windowHandle, 1]);
    await callWindow(0x88, [windowHandle, 1, 2, 4, 5]);
    assert.equal(await invoke(0x90, 0x89, [0x601, windowHandle], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    const windowOutput = new DataView(memory.globalMemory.buffer);
    assert.deepEqual(
      [0, 4, 8, 12].map((offset) => windowOutput.getInt32(0x601 + offset, true)),
      [1, 2, 4, 6],
    );
    await callWindow(0x83, [5, windowHandle]);
    const capturedWindow = graph.surfaces.snapshot(5);
    assert.ok(capturedWindow);
    assert.equal(capturedWindow.format, 2);
    assert.equal(capturedWindow.storage.view.getUint32(0, true), 0xff224466);
    assert.notEqual(capturedWindow.storage, windowObject.compositionBitmap.storage);
    const callWindowState = async (secondary, args, pushed = 0) => {
      assert.equal(await invoke(0x91, secondary, [windowHandle, ...args], 0), pushed);
    };
    await callWindowState(0x89, [25]);
    await callWindowState(0x8a, [1]);
    await callWindowState(0x8b, [1]);
    assert.equal(windowObject.lineSpacing, 25);
    assert.equal(windowObject.writingDirection, 1);
    assert.equal(windowObject.alignment, 1);
    await callWindowState(0x8d, [], 3);
    assert.deepEqual([pop32(child.state), pop32(child.state), pop32(child.state)], [2, 4, 1]);
    await callWindowState(0x8e, [], 1);
    assert.equal(pop32(child.state), 1);
    await callWindowState(0x8c, [3, 4]);
    await callWindowState(0x8d, [], 3);
    assert.deepEqual([pop32(child.state), pop32(child.state), pop32(child.state)], [4, 3, 1]);
    await callWindowState(0x8e, [], 1);
    assert.equal(pop32(child.state), 0);
    await callWindowState(0x8a, [0]);

    assert.equal(graph.surfaces.allocate(1, 2, 1, 2), 1);
    const image = graph.surfaces.snapshot(1);
    assert.ok(image);
    bitmapWrite32(image, 0, 0xff204060);
    bitmapWrite32(image, 4, 0xff6080a0);
    const pixel = (bitmap, x, y) =>
      bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true);
    const callWindowImage = async (secondary, args) => {
      assert.equal(await invoke(0x92, secondary, [windowHandle, ...args], 0), 0);
    };
    await callWindowImage(0x88, [1]);
    await callWindowImage(0x8a, [0xff112233]);
    assert.equal(pixel(windowObject.compositionBitmap, 0, 0), 0xff112233);
    graph.damage.clear();
    await callWindowImage(0x89, [1, 0, 1, 0x80, 0]);
    assert.deepEqual(graph.damage.snapshot(), [
      {key: windowObject.sortKey(), rectangle: {left: 12, top: 13, right: 13, bottom: 13}},
    ]);
    assert.equal(pixel(windowObject.compositionBitmap, 1, 0), 0xff204060);
    await callWindowImage(0x8c, [1]);
    graph.damage.clear();
    await callWindowImage(0x8d, [1, 2, 1, 0x80, 0]);
    assert.deepEqual(graph.damage.snapshot(), [
      {key: windowObject.sortKey(), rectangle: {left: 12, top: 15, right: 13, bottom: 15}},
    ]);
    assert.equal(pixel(windowObject.textBitmap, 1, 2), 0xff204060);
    assert.equal(pixel(windowObject.compositionBitmap, 1, 2), 0xff204060);
    graph.damage.clear();
    await callWindowImage(0x8e, []);
    assert.equal(pixel(windowObject.textBitmap, 1, 2), 0);
    assert.equal(pixel(windowObject.backgroundBitmap, 1, 2), 0xff112233);
    assert.equal(pixel(windowObject.compositionBitmap, 1, 2), 0xff000000);
    assert.ok(graph.damage.count > 0);
    await callWindowState(0x8d, [], 3);
    assert.deepEqual([pop32(child.state), pop32(child.state), pop32(child.state)], [2, 1, 1]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(graph.surfaces.release(1), 1);
    await callWindow(0x81, [windowHandle]);
    assert.equal(graph.manager.find('window', windowHandle), null);
    assert.equal(graph.surfaces.release(5), 1);
    assert.equal(graph.surfaces.release(0), 1);
    graph.compositor.defaultFormat = previousCompositorFormat;
  } finally {
    await fixture.close();
  }
});
