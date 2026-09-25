import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted disk pixel lower imports GDI rows into graph surfaces and borrows Scan0 backing', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke, memory} = fixture;
  const output = new DataView(memory.globalMemory.buffer);
  const callPixel = async (surface, x, y, expected) => {
    assert.equal(await invoke(0x92, 0x17, [0x300, surface, x, y], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(output.getUint32(0x300, true), expected);
  };
  try {
    assert.equal(graph.diskImagePixels.surfaces, graph.surfaces);
    assert.equal(graph.device.isPresent(), false);
    for (const secondary of [0xc4, 0xc5])
      assert.equal(
        definitions.some(({primary, secondary: slot}) => primary === 0x90 && slot === secondary),
        false,
      );

    const rgb = graph.diskImagePixels.selectImport(1, 0x21808);
    assert.deepEqual(rgb, {
      mode: 1,
      inputPixelFormat: 0x21808,
      lockPixelFormat: 0x26200a,
      surfaceFormat: 2,
      finalFormat: 1,
    });
    assert.equal(
      graph.diskImagePixels.importLocked(21, rgb, {
        bytes: Uint8Array.of(0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff),
        scan0Offset: 0,
        stride: 8,
        width: 2,
        height: 1,
        pixelFormat: 0x26200a,
      }),
      1,
    );
    assert.equal(graph.surfaces.snapshot(21).format, 1);
    await callPixel(21, 0, 0, 0xff332211);
    await callPixel(21, 1, 0, 0xff665544);

    const argb = graph.diskImagePixels.selectImport(-1, 0x26200a);
    assert.equal(argb.mode, 2);
    assert.deepEqual(graph.diskImagePixels.selectImport(0xffffffff, 0x26200a), argb);
    assert.equal(
      graph.diskImagePixels.importLocked(22, argb, {
        bytes: Uint8Array.of(0x11, 0x22, 0x33, 0x40, 0x44, 0x55, 0x66, 0x80),
        scan0Offset: 0,
        stride: 8,
        width: 2,
        height: 1,
        pixelFormat: 0x26200a,
      }),
      1,
    );
    assert.equal(graph.surfaces.snapshot(22).format, 2);
    await callPixel(22, 0, 0, 0x40332211);
    await callPixel(22, 1, 0, 0x80665544);

    const indexed = graph.diskImagePixels.selectImport(-1, 0x30803);
    assert.equal(indexed.mode, 3);
    assert.equal(
      graph.diskImagePixels.importLocked(23, indexed, {
        bytes: Uint8Array.of(1, 2, 3, 0xee, 4, 5, 6, 0xdd),
        scan0Offset: 0,
        stride: 4,
        width: 3,
        height: 2,
        pixelFormat: 0x30803,
      }),
      1,
    );
    assert.equal(graph.surfaces.snapshot(23).format, 3);
    for (const [x, y, value] of [
      [0, 0, 1],
      [2, 0, 3],
      [0, 1, 4],
      [2, 1, 6],
    ])
      await callPixel(23, x, y, value);

    for (const [surface, expectedFormat, expectedBytes] of [
      [21, 0x22009, [0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff]],
      [22, 0x26200a, [0x11, 0x22, 0x33, 0x40, 0x44, 0x55, 0x66, 0x80]],
    ]) {
      const scan0 = graph.diskImagePixels.prepareScan0(surface);
      assert.equal(scan0.pixelFormat, expectedFormat);
      assert.equal(scan0.storage, graph.surfaces.snapshot(surface).storage);
      assert.equal(scan0.scan0Offset, 0);
      assert.equal(scan0.scan0Stride, 8);
      assert.deepEqual(
        [...scan0.storage.bytes.subarray(scan0.scan0Offset, scan0.scan0Offset + 8)],
        expectedBytes,
      );
    }

    for (const surface of [23, 22, 21]) {
      assert.equal(await invoke(0x90, 0x12, [surface], 0), 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
