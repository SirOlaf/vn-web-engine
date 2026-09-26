import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDisplayDevice} from '../dist/engines/buriko/native/display-device.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';

import {
  BurikoMovieImage,
  BurikoMovieImageConfiguration,
} from '../dist/engines/buriko/native/movie-image.js';
import {BurikoTraditionalMovieRenderer} from '../dist/engines/buriko/native/movie-traditional-renderer.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';

test('traditional movie samples use the real dynamic texture and centered linear display quad in both orientations', async () => {
  const commits = [];
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
    addEventListener() {},
    removeEventListener() {},
    getContext: () => context,
  };
  const display = new BurikoNativeDisplayState(4, 4);
  assert.equal(display.setSizePreset(display.selectedSizePreset, 4, 4), 0);
  display.requestedWidth = display.requestedHeight = 4;
  display.verticalSynchronization = 0;
  const compositor = new BurikoBitmapCompositor();
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const manager = new BurikoDisplayManager(
    environment,
    new BurikoSurfaces(null, compositor, new BurikoDistributedAllocator(1)),
    display,
  );
  manager.configureDescriptor(4, 4, 1, 8);
  const device = new BurikoDisplayDevice(canvas, manager, new BurikoNativeClock(() => 100), {
    pixelShaderVersion: 0xffff0300,
    refreshRate: 60,
  });
  assert.equal(device.create(0), 0);
  const renderer = new BurikoTraditionalMovieRenderer(
    device,
    new BurikoMovieImage(new BurikoMovieImageConfiguration()),
  );
  const bytes = new Uint8Array(32),
    sampleView = new DataView(bytes.buffer);
  for (let x = 0; x < 4; x++) {
    sampleView.setUint32(x * 4, 0xff0000, true);
    sampleView.setUint32(16 + x * 4, 0x0000ff, true);
  }
  for (const height of [-2, 2]) {
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
    assert.equal(renderer.checkMediaType(type), 0);
    assert.equal(renderer.setMediaType(type), 0);
    assert.equal(
      await renderer.deliver({storage: new BurikoBitmapStorage(bytes.slice(), true), offset: 0}),
      0,
    );
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
  assert.equal(commits.length, 2);
  device.release();
});
