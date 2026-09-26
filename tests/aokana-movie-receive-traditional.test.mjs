import {AokanaMovieReceivePin} from '../dist/engines/buriko/games/aokana/native/movie-receive.js';
import {AokanaMovieFilterEvents} from '../dist/engines/buriko/games/aokana/native/movie-filter-events.js';
import {AokanaMovieReferenceClock} from '../dist/engines/buriko/games/aokana/native/movie-render-events.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaDisplayDevice} from '../dist/engines/buriko/games/aokana/native/display-device.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

import {
  AokanaMovieImage,
  AokanaMovieImageConfiguration,
} from '../dist/engines/buriko/games/aokana/native/movie-image.js';
import {AokanaTraditionalMovieRenderer} from '../dist/engines/buriko/games/aokana/native/movie-traditional-renderer.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';

test('actual receive pin retains its sample and render lock through queued display presentation', async () => {
  const commits = [],
    callbacks = [];
  const context = {
    createImageData: (width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (frame) => commits.push(frame.data.slice()),
  };
  const canvas = {
    width: 0,
    height: 0,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
      },
    },
    addEventListener() {},
    removeEventListener() {},
    getContext: () => context,
  };
  const display = new AokanaNativeDisplayState(4, 4);
  assert.equal(display.setSizePreset(display.selectedSizePreset, 4, 4), 0);
  display.requestedWidth = display.requestedHeight = 4;
  display.verticalSynchronization = 1;
  const compositor = new AokanaBitmapCompositor();
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const manager = new AokanaDisplayManager(
    environment,
    new AokanaSurfaces(null, compositor, new AokanaDistributedAllocator(1)),
    display,
  );
  manager.configureDescriptor(4, 4, 1, 8);
  const device = new AokanaDisplayDevice(canvas, manager, new AokanaNativeClock(() => 100), {
    pixelShaderVersion: 0xffff0300,
    refreshRate: 60,
  });
  assert.equal(device.create(0), 0);
  const renderer = new AokanaTraditionalMovieRenderer(
    device,
    new AokanaMovieImage(new AokanaMovieImageConfiguration()),
  );
  const bytes = new Uint8Array(32),
    sampleView = new DataView(bytes.buffer);
  for (let x = 0; x < 4; x++) {
    sampleView.setUint32(x * 4, 0xff0000, true);
    sampleView.setUint32(16 + x * 4, 0x0000ff, true);
  }
  for (const height of [-2]) {
    const format = new Uint8Array(88),
      info = new DataView(format.buffer);
    info.setInt32(52, 4, true);
    info.setInt32(56, height, true);
    const type = {
      majorType: '73646976-0000-0010-8000-00aa00389b71',
      subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
      formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
      format,
    };
    const events = new AokanaMovieFilterEvents(new AokanaWindowMessages(null));
    const pin = new AokanaMovieReceivePin(
      renderer,
      events,
      null,
      new AokanaMovieReferenceClock(() => 0),
    );
    assert.equal(pin.connect(type), 0);
    assert.equal(await pin.run(0n), 0);
    const sample = {
      storage: new AokanaBitmapStorage(bytes.slice(), true),
      offset: 0,
      time: null,
      discontinuity: true,
    };
    const receiving = pin.receive(sample);
    assert.equal(callbacks.length, 1);
    assert.equal(commits.length, 0);
    assert.equal(pin.pendingSample, sample);
    assert.equal(device.nativeLock.depth, 1);
    callbacks.shift()(100);
    assert.equal(await receiving, 0);
    assert.equal(pin.pendingSample, null);
    assert.equal(await pin.stop(), 0);
    pin.dispose();
    const texture = device.dynamicTexture;
    const row = (y) => texture.storage.view.getUint32(y * texture.pitch, true);
    assert.deepEqual(
      [row(0), row(1), row(2), row(3)],
      height < 0 ? [0, 0xff0000, 0x0000ff, 0] : [0, 0x0000ff, 0xff0000, 0],
    );
    const pixel = (y) => [...commits.at(-1).subarray(y * 16, y * 16 + 4)];
    assert.deepEqual(pixel(0), [0, 0, 0, 255]);
    // Vertical texel1.375 mixes5/8 and3/8. At column0, horizontal texel-1/8
    // blends1/8 black border: RGB weights35/64 and21/64, rounded to139 and84.
    assert.deepEqual(pixel(2), height < 0 ? [139, 0, 84, 255] : [84, 0, 139, 255]);
    assert.equal(device.nativeLock.depth, 0);
    assert.equal(display.lastPresentMilliseconds, 100);
  }
  assert.equal(commits.length, 1);
  device.release();
});
