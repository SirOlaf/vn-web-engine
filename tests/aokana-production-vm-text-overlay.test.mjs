import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted text layout settings clone overlay frames and share reading font policy', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const state = graph.windowState.textLayout;
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const fields = () => [
    state.readingFontSize,
    state.readingWidth,
    state.readingXOffset,
    state.readingYOffset,
    state.readingValue1C90F8,
    state.readingValue1C90F4,
  ];
  try {
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(state.surfaces, graph.surfaces);
    assert.equal(state.text, graph.text);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x90 && [0x98, 0x9a].includes(secondary)) ||
            (primary === 0x91 && [0x97, 0x9a].includes(secondary)) ||
            (primary === 0x92 && secondary === 0x97),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0x90, 0x98],
        [0x90, 0x9a],
        [0x91, 0x97],
        [0x91, 0x9a],
        [0x92, 0x97],
      ],
    );
    await call(0x90, 0x11, [5, 2, 2, 2]);
    await call(0x90, 0x13, [5, 0xff804020]);
    await call(0x90, 0x11, [6, 1, 3, 1]);
    await call(0x90, 0x13, [6, 0x102030]);
    const bp = new DataView(memory.globalMemory.buffer);
    [5, 0xffffffff, 6].forEach((id, index) => bp.setUint32(0x100 + index * 4, id, true));
    await call(0x90, 0x98, [3, 0x100]);
    assert.equal(state.overlayFrameCount, 3);
    assert.deepEqual(
      state.overlayFrames.map((frame) => [frame.width, frame.height, frame.format]),
      [
        [2, 2, 2],
        [0, 0, 0],
        [1, 3, 2],
      ],
    );
    assert.equal(state.overlayFrames[1].storage, null);
    assert.notEqual(state.overlayFrames[0].storage, graph.surfaces.snapshot(5).storage);
    const firstPixel = () =>
      state.overlayFrames[0].storage.view.getUint32(state.overlayFrames[0].offset, true);
    assert.equal(firstPixel() & 0xffffff, 0x804020);
    await call(0x90, 0x13, [5, 0xff000000]);
    assert.equal(firstPixel() & 0xffffff, 0x804020);
    await call(0x90, 0x9a, [3, 7, 11], 1);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(
      [state.overlayPositionMode, state.overlayPositionX, state.overlayPositionY],
      [3, 7, 11],
    );

    await call(0x91, 0x9a, [0x80000002, 7]);
    assert.equal(state.field1D27A0, 7);
    const font = graph.fonts.registerName(graph.text.encodeWide('Shared', 1), 1);
    assert.ok(font >= 0);
    await call(0x91, 0x97, [font, 9, 80, 2, 3]);
    assert.deepEqual(fields(), [9, 80, 2, 3, 0xffffffff, 0xffffffff]);
    assert.equal(graph.text.decodeAuto({bytes: state.readingFontName, offset: 0}), 'Shared');
    await call(0x92, 0x97, [font, 10, 75, 4, 5, 0x123456, 0xabcdef]);
    assert.deepEqual(fields(), [10, 75, 4, 5, 0x123456, 0xabcdef]);
    await call(0x90, 0x98, [0, 0]);
    assert.deepEqual([state.overlayFrameCount, state.overlayFrames], [0, null]);
    for (const id of [6, 5]) {
      await call(0x90, 0x12, [id], 1);
      assert.equal(pop32(child.state), 1);
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
