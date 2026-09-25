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
import {aokanaPresentationTextureSample} from '../dist/engines/buriko/games/aokana/native/presentation-sampling.js';
import {invalidateCanvasFrame} from '../dist/graphics/canvas-frame-presenter.js';
import {AokanaBrowserMfController} from '../dist/engines/buriko/games/aokana/native/movie-mf-browser-session.js';
import {AokanaFullscreenMovieState} from '../dist/engines/buriko/games/aokana/native/movie-fullscreen-state.js';

/** No browser/DOM/image display: the canvas boundary is a byte-array commit and a queued clock callback. */
function fixture() {
  let tick = 100;
  const commits = [],
    uploads = [],
    callbacks = [],
    events = new Map();
  let sink = new Uint8ClampedArray(0);
  const context = {
    createImageData: (width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData(frame, _x, _y, x = 0, y = 0, width = frame.width, height = frame.height) {
      if (sink.length !== frame.data.length) sink = new Uint8ClampedArray(frame.data.length);
      for (let row = y; row < y + height; row++) {
        const first = (row * frame.width + x) * 4;
        sink.set(frame.data.subarray(first, first + width * 4), first);
      }
      uploads.push({x, y, width, height});
      commits.push(sink.slice());
    },
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
  return {device, display, write, present, commits, canvas, events, uploads};
}
const pixel = (bytes, x, y, width = 8) => [
  ...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

test('returning from a retained MF movie restores the unchanged ordinary frame', async () => {
  const s = fixture();
  s.device.setFilter(2);
  s.write(Array(8).fill(0x123456));
  s.device.prepare(1, null, 0, 0);
  const ordinary = (await s.present()).slice();
  // This exercises the movie/presenter handoff with byte arrays only, without browser assets.
  class Video extends EventTarget {
    videoWidth = 8;
    videoHeight = 4;
    readyState = 2;
    currentTime = 0;
    data = new Uint8ClampedArray(8 * 4 * 4).fill(213);
    load() {
      if (this.src) this.dispatchEvent(new Event('loadedmetadata'));
    }
    play() {
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }
    pause() {}
    removeAttribute() {
      this.src = '';
    }
    requestVideoFrameCallback(callback) {
      this.callback = callback;
      return 1;
    }
    cancelVideoFrameCallback() {
      this.callback = null;
    }
  }
  const video = new Video();
  const retained = {
    width: 0,
    height: 0,
    data: new Uint8ClampedArray(video.data.length),
    getContext: () => ({drawImage: (source) => retained.data.set(source.data)}),
  };
  const document = {createElement: (tag) => (tag === 'video' ? video : retained)};
  const target = s.canvas.getContext('2d');
  target.drawImage = (source) => target.putImageData(source);
  const fullscreen = new AokanaFullscreenMovieState();
  const controller = new AokanaBrowserMfController(
    document,
    {surface: s.canvas, presentationMode: 'canvas'},
    fullscreen,
  );
  fullscreen.controller = controller;
  try {
    await controller.open(new Uint8Array(), new AbortController().signal);
    video.callback();
    assert.deepEqual(s.commits.at(-1), video.data);
    video.data.fill(99);
    fullscreen.displayControl.repaint();
    assert.equal(s.commits.at(-1)[0], 213); // Repaint uses the retained decoded frame.
  } finally {
    controller.close();
  }
  const previous = s.commits.length;
  assert.deepEqual(await s.present(), ordinary);
  assert.equal(s.commits.length, previous + 1);
  assert.deepEqual(s.uploads.at(-1), {x: 0, y: 0, width: 8, height: 4});
});

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

test('repeated full uploads reuse identical sampled pixels and redraw after a source change', () => {
  const s = fixture();
  s.device.setFilter(2);
  const rasterize = s.device.rasterizeQuad.bind(s.device);
  let rasterizations = 0;
  s.device.rasterizeQuad = (...args) => {
    rasterizations++;
    return rasterize(...args);
  };
  s.write(Array(8).fill(0x804020));
  s.device.prepare(1, null, 0, 0);
  s.device.prepare(1, null, 0, 0);
  assert.equal(rasterizations, 1);
  s.write(Array(8).fill(0x804020));
  s.device.prepare(1, null, 0, 0);
  assert.equal(rasterizations, 1);
  s.write(Array(8).fill(0x204080));
  s.device.prepare(1, null, 0, 0);
  assert.equal(rasterizations, 2);
  s.device.setFilter(0);
  s.device.prepare(1, null, 0, 0);
  assert.equal(rasterizations, 3);
});

test('unchanged frames keep present timing and restore the canvas after other drawing and reset', async () => {
  const s = fixture();
  s.device.setFilter(2);
  s.write(Array(8).fill(0x804020));
  s.device.prepare(1, null, 0, 0);
  const original = await s.present();
  s.device.prepare(1, null, 0, 0);
  await s.present();
  assert.equal(s.commits.length, 1);
  // The shared protocol is used by direct main-window GDI and other presenters.
  invalidateCanvasFrame(s.canvas);
  assert.deepEqual(await s.present(), original);
  assert.equal(s.commits.length, 2);
  s.write([0x204080]);
  s.device.prepare(1, [{left: 0, top: 0, right: 0, bottom: 0}], 0, 0);
  assert.deepEqual(pixel(await s.present(), 0, 0), [32, 64, 128, 255]);
  assert.equal(s.commits.length, 3);
  assert.deepEqual(s.uploads.at(-1), {x: 0, y: 0, width: 2, height: 2});
  s.write([0x010203, 0x040506]);
  s.device.prepare(1, [{left: 0, top: 0, right: 0, bottom: 0}], 0, 0);
  s.device.prepare(1, [{left: 1, top: 0, right: 1, bottom: 0}], 0, 0);
  assert.deepEqual(await s.present(), s.device.frame.data);
  assert.deepEqual(s.uploads.at(-1), {x: 0, y: 0, width: 4, height: 2});
  s.write([0x204080]);
  s.device.prepare(1, [{left: 0, top: 0, right: 0, bottom: 0}], 0, 0);
  invalidateCanvasFrame(s.canvas);
  assert.deepEqual(await s.present(), s.device.frame.data);
  assert.deepEqual(s.uploads.at(-1), {x: 0, y: 0, width: 8, height: 4});
  s.events.get('contextlost')({preventDefault() {}});
  assert.equal(await s.device.present({waitCount: 99}), 0x80000000);
  s.events.get('contextrestored')();
  assert.equal(s.device.cooperativeStatus(), 0x80000001);
  s.write(Array(8).fill(0x804020));
  s.device.prepare(1, null, 0, 0);
  assert.deepEqual(await s.present(), original);
  assert.equal(s.commits.length, 6);
});

test('optimized point and linear frames retain the reference quad sampling at shifted scale', () => {
  const s = fixture();
  s.display.requestedWidth = 11;
  s.display.requestedHeight = 7;
  assert.equal(s.device.reset(1, 0), 0);
  s.write([0x184276, 0x41a3c7, 0x962417, 0xe89b53, 0x352fe4, 0xc66419, 0x4088ab, 0xf12091]);
  for (const [mode, sampler] of [
    [2, 'point'],
    [0, 'linear'],
  ]) {
    s.device.setFilter(mode);
    s.device.prepare(1, null, 1, -1);
    const actual = s.device.frame.data;
    const expected = new Uint8ClampedArray(actual.length);
    for (let offset = 3; offset < expected.length; offset += 4) expected[offset] = 255;
    const quad = new DataView(s.device.vertices.buffer);
    const left = quad.getFloat32(0, true),
      top = quad.getFloat32(4, true);
    const right = quad.getFloat32(28, true),
      bottom = quad.getFloat32(60, true);
    const uMax = quad.getFloat32(48, true),
      vMax = quad.getFloat32(80, true);
    const width = Math.fround(right - left),
      height = Math.fround(bottom - top);
    for (let row = Math.max(0, Math.ceil(top)); row < Math.min(7, Math.ceil(bottom)); row++)
      for (
        let column = Math.max(0, Math.ceil(left));
        column < Math.min(11, Math.ceil(right));
        column++
      ) {
        const u = Math.fround(Math.fround(Math.fround(column - left) / width) * uMax);
        const v = Math.fround(Math.fround(Math.fround(row - top) / height) * vMax);
        const color = aokanaPresentationTextureSample(s.device.sampled, u, v, sampler);
        const offset = (row * 11 + column) * 4;
        for (let channel = 0; channel < 3; channel++)
          expected[offset + channel] = Math.fround(color[channel] * 255);
      }
    assert.deepEqual(actual, expected);
    if (sampler === 'linear') {
      assert.ok(s.device.linearRasterizer, 'the ordinary frame selected the shared SIMD kernel');
      // An unavailable accelerator must preserve the same complete device frame.
      s.device.linearRasterizer = null;
      s.device.rasterValid = false;
      s.device.prepare(1, null, 1, -1);
      assert.deepEqual(s.device.frame.data, expected);
    }
  }
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
