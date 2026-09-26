import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDisplayFrames} from '../dist/engines/buriko/native/display-frames.js';
import {BurikoFrameMetrics} from '../dist/engines/buriko/native/frame-metrics.js';
import {BurikoMovieRegistry} from '../dist/engines/buriko/native/movie-registry.js';
import {BurikoFullscreenMovieState} from '../dist/engines/buriko/native/movie-fullscreen-state.js';
import {BurikoDisplayTexture} from '../dist/engines/buriko/native/display-texture.js';
import {BurikoDisplayRenderer} from '../dist/engines/buriko/native/display-renderer.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoThreadedCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {BurikoParticleVariants} from '../dist/engines/buriko/native/particle-images.js';
import {BurikoParticleDisplays} from '../dist/engines/buriko/native/particle-displays.js';
import {BurikoParticleFrames} from '../dist/engines/buriko/native/particle-frames.js';

function setup() {
  let now = 100;
  const clock = new BurikoNativeClock(() => now),
    ticks = new BurikoSystemTicks({now: () => now + 1000});
  const compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1);
  const processing = new BurikoDistributedProcessing(allocator, 1);
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const manager = new BurikoDisplayManager(
    environment,
    new BurikoSurfaces(null, compositor, allocator),
    new BurikoNativeDisplayState(1920, 1080),
  );
  const renderer = new BurikoDisplayRenderer(manager, 16, processing);
  manager.configureDescriptor(4, 4, 1, 16);
  const texture = new BurikoDisplayTexture(4, 4, 22);
  manager.setDisplayTexture(texture);
  return {
    manager,
    environment,
    renderer,
    clock,
    ticks,
    allocator,
    processing,
    setTime: (value) => {
      now = value;
    },
  };
}

test('frame policy preserves pending redraw, deadline stepping and measured draw commits', async () => {
  const s = setup(),
    calls = [];
  const device = {
    refreshRate: 60,
    cooperativeStatus: () => 0,
    prepare: (...args) => calls.push(['prepare', ...args]),
    present: async (output) => {
      calls.push(['present']);
      output.waitCount = 2;
      return 0;
    },
  };
  const metrics = new BurikoFrameMetrics(
    {queryCounter: () => s.clock.read(), queryFrequency: () => 1000n},
    s.clock,
    {refreshRate: 60, readRasterScanline: () => 0x81000000},
  );
  metrics.enable(1);
  const inline = {target: null, state: {visible: 0}};
  const frames = new BurikoDisplayFrames(
    s.manager,
    device,
    s.clock,
    s.ticks,
    metrics,
    new BurikoMovieRegistry(),
    new BurikoFullscreenMovieState(),
    inline,
    {invalidateVisible: () => calls.push(['children'])},
  );
  frames.setFrameFrequency(20);
  s.manager.redraw.request(1);
  assert.equal(await frames.poll(), 2);
  assert.deepEqual(calls, [['prepare', 1, null, 0, 0], ['present'], ['children']]);
  assert.equal(s.manager.displayState.frameDeadline, 150);
  assert.equal(metrics.read(0), 1);
  calls.length = 0;
  s.setTime(120);
  s.manager.redraw.request(0);
  assert.equal(await frames.poll(), -1);
  s.manager.displayState.continuousPresentation = 1;
  assert.equal(await frames.poll(), 2);
  assert.equal(metrics.read(0), 1);
  assert.equal(s.manager.redraw.pending, 1);
  s.manager.displayState.continuousPresentation = 0;
  s.setTime(175);
  s.environment.damage.record(0, {left: 1, top: 1, right: 2, bottom: 2});
  calls.length = 0;
  assert.equal(await frames.poll(), 2);
  assert.deepEqual(calls[0], ['prepare', 1, [{left: 1, top: 1, right: 2, bottom: 2}], 0, 0]);
  assert.equal(s.manager.displayState.frameDeadline, 200);
  assert.equal(s.manager.displayState.measuredDrawCount, 2);
  assert.equal(metrics.read(0), 2);
});

test('transient presentation paints EDIT immediately before child invalidation without consuming posted input', async () => {
  const s = setup(),
    calls = [];
  const messages = new BurikoWindowMessages(new BurikoNativeInput(s.manager.displayState, s.clock));
  const target = messages.createTarget();
  messages.post({target: 'main', message: 0x100, wParam: 65, lParam: 0});
  const inline = {
    target,
    state: {visible: 1},
    messages,
    handleMessage: async (message) => {
      calls.push(['paint', message.target, s.manager.displayState.inlinePaintSuppression]);
      return true;
    },
  };
  const device = {
    refreshRate: 60,
    prepare: (...args) => calls.push(['prepare', ...args]),
    present: async () => {
      calls.push(['present']);
      return 0;
    },
  };
  const frames = new BurikoDisplayFrames(
    s.manager,
    device,
    s.clock,
    s.ticks,
    null,
    new BurikoMovieRegistry(),
    new BurikoFullscreenMovieState(),
    inline,
    {invalidateVisible: () => calls.push(['children'])},
  );
  assert.equal(await frames.presentTransient(3, -2), 0);
  assert.deepEqual(calls, [
    ['prepare', 1, null, 3, -2],
    ['present'],
    ['paint', target, 1],
    ['children'],
  ]);
  assert.equal(s.manager.displayState.inlinePaintSuppression, 0);
  assert.equal(messages.take().message, 0x100);
  assert.equal(messages.take(), null);
  frames.requestDeviceChange(1);
  assert.equal(s.manager.displayState.deviceChangeDeadline, 1201);
});

test('particle main-loop updates visit every actual slot while refresh applies visibility and minimum key', () => {
  const s = setup(),
    seen = [];
  const particles = new BurikoParticleDisplays(
    s.manager,
    new BurikoParticleVariants(),
    new BurikoThreadedCrtRandom(() => s.allocator.currentActor),
    s.clock,
    s.processing,
  );
  const handles = [0, 1, 2].map(() => particles.create(4, 4).handle);
  for (const handle of handles) {
    const object = particles.find(handle);
    object.updateParticle = () => seen.push(['update', handle]);
    object.refreshParticle = () => seen.push(['refresh', handle]);
    particles.setRefreshInterval(handle, 50);
    object.setActivation(1);
  }
  particles.find(handles[1]).setActivation(0);
  particles.find(handles[0]).setLayer(1);
  particles.find(handles[2]).setLayer(2);
  s.manager.setMinimumLayer(2);
  const frames = new BurikoParticleFrames(particles, s.clock);
  frames.updateAll();
  frames.pollRefresh();
  assert.deepEqual(
    seen,
    handles.map((handle) => ['update', handle]).concat([['refresh', handles[2]]]),
  );
  const deadlines = () => {
    const values = [];
    for (let n = particles.scheduleHead; n !== null; n = n.next) values.push(n.nextTick);
    return values;
  };
  assert.deepEqual(deadlines(), [150, 150, 150]);
  assert.equal(s.manager.redraw.mode, 0);
  seen.length = 0;
  s.setTime(175);
  frames.pollRefresh();
  assert.deepEqual(seen, [['refresh', handles[2]]]);
  assert.deepEqual(deadlines(), [200, 200, 200]);
});
