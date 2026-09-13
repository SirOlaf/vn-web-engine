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

/** No browser/DOM/image display: the canvas boundary is a byte-array commit and a queued clock callback. */
function fixture() {
  let tick = 100;
  const commits = [],
    callbacks = [],
    events = new Map();
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
        requestAnimationFrame: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
      },
    },
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name) => events.delete(name),
    getContext: () => context,
  };
  const display = new AokanaNativeDisplayState(8, 4);
  display.setSizePreset(2, 4, 2);
  display.requestedWidth = 8;
  display.requestedHeight = 4;
  const compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1);
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 1}),
  );
  const manager = new AokanaDisplayManager(
    environment,
    new AokanaSurfaces(null, compositor, allocator),
    display,
  );
  manager.configureDescriptor(4, 2, 1, 8);
  const device = new AokanaDisplayDevice(canvas, manager, new AokanaNativeClock(() => tick), {
    pixelShaderVersion: 0xffff0300,
    refreshRate: 60,
  });
  assert.equal(device.create(0), 0);
  const write = (colors) => {
    assert.equal(manager.lockDisplay(), 1);
    const {bitmap} = environment.displayContext;
    colors.forEach((color, index) =>
      bitmap.storage.view.setUint32((index >>> 2) * bitmap.stride + (index & 3) * 4, color, true),
    );
    manager.unlockDisplay();
  };
  const present = async () => {
    const output = {waitCount: 99},
      previous = commits.length;
    const pending = device.present(output);
    assert.equal(commits.length, previous);
    assert.equal(callbacks.length, 1);
    tick += 16;
    callbacks.shift()(tick);
    assert.equal(await pending, 0);
    assert.equal(output.waitCount, 0);
    assert.equal(display.lastPresentMilliseconds, tick);
    return commits.at(-1);
  };
  return {device, display, write, present, commits, canvas};
}
const pixel = (bytes, x, y, width = 8) => [
  ...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

test('concrete software device uploads dirty texels, samples the quad and commits on its frame callback', async () => {
  const s = fixture();
  s.device.setFilter(2);
  s.write([0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x123456, 0x123456, 0x123456, 0x123456]);
  s.device.prepare(1, null, 0, 0);
  let result = await s.present();
  assert.deepEqual(pixel(result, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(result, 2, 0), [0, 255, 0, 255]);
  assert.deepEqual(pixel(result, 4, 1), [0, 0, 255, 255]);
  assert.deepEqual(pixel(result, 7, 3), [18, 52, 86, 255]);
  s.write([0x000000, 0xffffff]);
  s.device.prepare(1, [{left: 1, top: 0, right: 1, bottom: 0}], 0, 0);
  result = await s.present();
  assert.deepEqual(pixel(result, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(result, 2, 0), [255, 255, 255, 255]);
  s.device.prepare(0, [], 1, 0);
  result = await s.present();
  assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(result, 2, 0), [255, 0, 0, 255]);
  s.device.prepare(0, [], 0, 0);
  result = await s.present();
  assert.deepEqual(pixel(result, 0, 0), [255, 0, 0, 255]);
});

test('concrete filter selection preserves shader-mode window fallback and normalized constant color', async () => {
  const s = fixture();
  s.write(Array(8).fill(0x804020));
  assert.equal(s.device.setFilter(1), 1);
  s.device.prepare(1, null, 0, 0);
  let result = await s.present();
  assert.deepEqual(pixel(result, 0, 0), [128, 64, 32, 255]);
  assert.deepEqual(pixel(result, 7, 3), [128, 64, 32, 255]);
  assert.equal(s.device.setFilter(4), 1);
  s.device.prepare(0, [], 0, 0);
  result = await s.present();
  assert.deepEqual(pixel(result, 3, 2), [128, 64, 32, 255]);
  assert.equal(s.device.readRasterScanline({}), 0x81000000);
  assert.equal(s.device.rasterStatusAvailable, false);
});

test('fullscreen keeps the raw desktop backbuffer and the native adjusted viewport distinct', async () => {
  const s = fixture();
  s.display.desktopWidth = 16;
  assert.equal(s.device.create(1), 0);
  assert.equal(s.display.fullscreen, 1);
  assert.equal(s.canvas.width, 16);
  s.device.setFilter(2);
  s.write(Array(8).fill(0xffffff));
  s.device.prepare(1, null, 0, 0);
  const result = await s.present();
  assert.deepEqual(pixel(result, 7, 2, 16), [255, 255, 255, 255]);
  assert.deepEqual(pixel(result, 8, 2, 16), [0, 0, 0, 255]);
});
