import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDisplayFrames} from '../dist/engines/buriko/native/display-frames.js';
import {BurikoFrameMetrics} from '../dist/engines/buriko/native/frame-metrics.js';
import {BurikoMovieRegistry} from '../dist/engines/buriko/native/movie-registry.js';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';
import {BurikoChildWindows} from '../dist/engines/buriko/native/child-windows.js';
import {BurikoBitmapText} from '../dist/engines/buriko/native/font-bitmap.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoMovieImage,
  BurikoMovieImageConfiguration,
} from '../dist/engines/buriko/native/movie-image.js';
import {BurikoMovieRenderer} from '../dist/engines/buriko/native/movie-renderer.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {createGroup91PresentationSettings} from '../dist/engines/buriko/native/group-91-presentation-settings.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

function media(width, height) {
  const format = new Uint8Array(88),
    view = new DataView(format.buffer);
  view.setBigInt64(40, 400000n, true);
  view.setInt32(52, width, true);
  view.setInt32(56, height, true);
  return {
    majorType: '73646976-0000-0010-8000-00aa00389b71',
    subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
    formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
    format,
  };
}

test('presentation settings reach shared frame policy and movie surface geometry', async () => {
  const s = deviceServiceFixture(),
    calls = [],
    configuration = new BurikoMovieImageConfiguration();
  const slots = createGroup91PresentationSettings(s.manager.displayState, configuration);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  function invoke(secondary, value) {
    const slot = slots.find((entry) => entry.secondary === secondary);
    assert.equal(slot.primary, 0x91);
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][secondary]);
    push32(thread, value);
    assert.equal(slot.execute({thread}), 0);
    if (secondary === 9) assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
  }
  const clock = s.device.clock,
    inline = s.controller.inline;
  s.canvas.getContext().putImageData = (frame, x, y) =>
    calls.push(['present', frame.width, frame.height, x, y]);
  s.display.verticalSynchronization = 0;
  s.manager.configureDescriptor(4, 2, 1, 8);
  assert.equal(s.device.create(0), 0);
  const children = new BurikoChildWindows(
    s.canvas.ownerDocument,
    s.parent,
    {},
    inline.fonts.text,
    s.manager.surfaces,
    s.manager.surfaces.compositor,
    new BurikoBitmapText(inline.fonts, s.manager.surfaces.compositor),
    inline.dialogs,
    s.messages,
    inline.keyboard,
    {frameWidth: 0, frameHeight: 0, verticalScrollbarWidth: 0, horizontalScrollbarHeight: 0},
    new Uint8Array([0]),
    s.canvas,
  );
  children.initialize();
  const metrics = new BurikoFrameMetrics(
    {queryCounter: () => clock.read(), queryFrequency: () => 1000n},
    clock,
    {refreshRate: 60, readRasterScanline: () => 0x81000000},
  );
  const frames = new BurikoDisplayFrames(
    s.manager,
    s.device,
    clock,
    s.controller.ticks,
    metrics,
    new BurikoMovieRegistry(),
    s.controller.fullscreenMovie,
    inline,
    children,
  );
  s.manager.redraw.pending = 0;
  invoke(0, 1);
  assert.equal(await frames.poll(), 0);
  assert.deepEqual(calls, [['present', 8, 4, 0, 0]]);
  invoke(0, 0);
  assert.equal(await frames.poll(), -1);
  assert.equal(calls.length, 1);

  const image = new BurikoMovieImage(configuration);
  const movie = new BurikoMovieRenderer(
    s.manager.surfaces,
    1,
    image,
    new BurikoNativeNotifications(),
  );
  assert.equal(image.checkMediaType(media(2, 2)), 0);
  for (const [mode, width] of [
    [0, 3],
    [1, 2],
  ]) {
    invoke(9, mode);
    assert.equal(movie.setMediaType(media(3, 2)), 0);
    const bitmap = s.manager.surfaces.snapshot(1);
    assert.deepEqual([bitmap.width, bitmap.height], [width, 2]);
    for (let y = 0; y < 2; y++) {
      const offset = bitmap.offset + y * bitmap.stride;
      bitmap.storage.range(offset, width * 4, true);
      assert.deepEqual(
        Array.from(bitmap.storage.bytes.subarray(offset, offset + width * 4)),
        new Array(width * 4).fill(0),
      );
    }
  }
});
