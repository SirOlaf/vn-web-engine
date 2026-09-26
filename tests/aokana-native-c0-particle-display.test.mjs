import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoParticleDisplays} from '../dist/engines/buriko/native/particle-displays.js';
import {BurikoParticleVariants} from '../dist/engines/buriko/native/particle-images.js';
import {BurikoThreadedCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {allocateBurikoBitmap, fillBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroupC0Particle} from '../dist/engines/buriko/native/group-c0-particle.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';

function fixture() {
  let now = 100;
  const allocator = new BurikoDistributedAllocator(3);
  const processing = new BurikoDistributedProcessing(allocator, 3);
  const random = new BurikoThreadedCrtRandom(() => allocator.currentActor);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const damage = new BurikoDisplayDamage(64, {left: 0, top: 0, right: 999, bottom: 999});
  const environment = new BurikoDisplayObjectEnvironment(compositor, damage);
  const surfaces = new BurikoSurfaces(null, compositor, allocator);
  for (let i = 0; i < 3; i++) {
    surfaces.allocate(i, 32, 32, 2);
    fillBurikoBitmap(surfaces.snapshot(i), 0xff112233 + i);
  }
  const manager = new BurikoDisplayManager(
    environment,
    surfaces,
    new BurikoNativeDisplayState(1000, 1000),
  );
  const particles = new BurikoParticleDisplays(
    manager,
    new BurikoParticleVariants(),
    random,
    new BurikoNativeClock(() => now),
    processing,
  );
  return {
    particles,
    manager,
    damage,
    setTick: (tick) => {
      now = tick;
    },
  };
}

test('particle display uses actual manager slots, native default layer and expanded key reversal', () => {
  const {particles, manager} = fixture();
  const a = particles.create(64, 48),
    b = particles.create(80, 60);
  assert.deepEqual(
    [a, b],
    [
      {result: 0, handle: 0xc0000000},
      {result: 0, handle: 0xc0000001},
    ],
  );
  const object = particles.find(a.handle);
  assert.equal(object, manager.find('particle', a.handle));
  assert.equal(object.controller.processing, particles.processing);
  assert.equal(object.depthOrder, 0);
  assert.equal(particles.find(b.handle).depthOrder, 1);
  assert.equal(manager.categoryCount(6), 2);
  assert.equal(object.layers[0].format, 2);
  assert.equal(object.bitmap.format, 1);
  assert.deepEqual(object.depths, [32767 * 256]);
  assert.equal(
    particles.configureLayers(
      a.handle,
      2,
      (i) => [100, 200][i],
      (i) => [0, 2][i],
    ),
    0,
  );
  assert.equal(object.setLayer(5), 1);
  const keys = new Uint32Array(2);
  object.copyExpandedSortKeys(keys);
  assert.deepEqual([...keys], [(object.sortKey() + 2 * 65536) >>> 0, object.sortKey()]);
  assert.equal(object.findExpandedSortKey(keys[0]), 1);
  assert.equal(object.findExpandedSortKey(keys[1]), 0);
  assert.deepEqual(object.depths, [100 * 256, 300 * 256]);
});

test('particle screen refresh collects two ordinary frame histories and composites the selected layer', () => {
  const {particles, damage} = fixture();
  const {handle} = particles.create(64, 64),
    object = particles.find(handle);
  particles.configureImages(0, 0, 1, 0, 0, 0, 0);
  particles.variants.configureSnow(0, [0, 10 * 65536, 0, 0, 0, 0, 0, 0, 0, 0]);
  particles.configureCamera(handle, [0, 0, -100 * 65536, 0, 0, 0, 100, 32, 32]);
  particles.setTarget(handle, 0, 0, 1, 0);
  object.updateParticle();
  object.refreshParticle();
  assert.deepEqual(object.damageHistory[0], [{left: 24, top: 19, right: 39, bottom: 34}]);
  assert.equal(object.damageIndex, 1);
  damage.clear();
  object.refreshParticle();
  assert.deepEqual(object.damageHistory[1], object.damageHistory[0]);
  assert.equal(object.damageIndex, 0);
  const destination = allocateBurikoBitmap(64, 64, 1);
  fillBurikoBitmap(destination, 0);
  object.draw(destination, {left: 0, top: 0, right: 63, bottom: 63}, object.sortKey());
  assert.equal(bitmapRead32(destination, 19 * destination.stride + 24 * 4), 0x00112233);
});

test('particle refresh schedule appends live nodes and retains deadlines across interval changes', () => {
  const {particles, setTick} = fixture();
  const a = particles.create(16, 16).handle,
    b = particles.create(16, 16).handle;
  particles.setRefreshInterval(a, 20);
  const first = particles.scheduleHead;
  assert.equal(first.nextTick, 100);
  setTick(150);
  particles.setRefreshInterval(b, 30);
  const second = first.next;
  assert.equal(second.nextTick, 150);
  particles.setRefreshInterval(a, 40);
  assert.equal(particles.scheduleHead, first);
  assert.equal(first.nextTick, 100);
  assert.equal(first.interval, 40);
  particles.setRefreshInterval(a, 0);
  assert.equal(particles.scheduleHead, second);
  assert.equal(second.next, null);
  particles.setRefreshInterval(a, 50);
  particles.clearRefreshScheduleForProgram();
  assert.equal(particles.scheduleHead, null);
  assert.equal(particles.find(a) !== null, true);
  assert.equal(particles.find(b) !== null, true);
  particles.setRefreshInterval(b, 60);
  assert.equal(particles.scheduleHead.handle, b);
});

test('particle image timing modes retain their three different native rate conversions', () => {
  const {particles} = fixture();
  for (const [mode, expected] of [
    [0, [2048, 4096]],
    [1, [2048, -683]],
    [2, [2048, 1024]],
  ]) {
    particles.setImageTimingMode(mode);
    assert.equal(particles.configureImages(0, mode, 2, 0, 64, 32, 2), 0);
    const record = particles.variants.snowImages[mode];
    assert.deepEqual([record.duration, record.durationSpread], expected);
  }
});

test('all24 particle wrappers use native slots, stack order and shared concrete service state', () => {
  const {particles, manager} = fixture();
  const errors = {
    files: {text: {encodeWide: (text) => text}},
    threadFatal: (_thread, _diagnostics, text) => {
      throw new Error(text);
    },
  };
  const definitions = createGroupC0Particle(particles, errors);
  assert.equal(definitions.length, 24);
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0xc0][slot.secondary]);
  const handlers = new Map(definitions.map((slot) => [slot.secondary, slot.execute]));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(),
    context = {thread, memory, diagnostics: {}};
  memory.writeU32(thread, 0x10000000, 65536);
  memory.writeU32(thread, 0x10000004, 100);
  memory.writeU32(thread, 0x10000008, 200);
  memory.writeU32(thread, 0x1000000c, 0);
  memory.writeU32(thread, 0x10000010, 1);
  const visited = new Set();
  const call = (code, args) => {
    args.forEach((v) => push32(thread, v));
    assert.equal(handlers.get(code)(context), 0);
    visited.add(code);
  };
  call(0x00, [64, 64]);
  const handle = pop32(thread),
    object = particles.find(handle);
  call(0x04, [handle, 1]);
  call(0x05, [handle, 3, 4, 0x20, 17, 2]);
  assert.deepEqual(object.position(), {x: 3, y: 4});
  assert.equal(object.blendMode, 0x20);
  assert.equal(object.getBlendValue(), 17);
  assert.equal(object.getLayer(), 2);
  call(0x06, [handle, 2, 0x10000004, 0x1000000c]);
  assert.deepEqual(object.depthSteps, [100, 200]);
  assert.deepEqual(object.layerOffsets, [0, 1]);
  call(0x08, [handle]);
  call(0x09, [handle, 30]);
  assert.equal(particles.scheduleHead.interval, 30);
  call(0x0a, [handle, 321]);
  assert.equal(object.maximumDamageRectangles, 321);
  call(0x0b, [handle, 0, 0, -100 * 65536, 0, 0, 0, 100, 31, 29]);
  assert.equal(object.centerX, 31);
  assert.equal(object.centerY, 29);
  call(0x0c, [handle, 10]);
  call(0x0d, [handle, 0]);
  call(0x0f, [handle]);
  call(0x10, [handle, 1, 256, 0, 512, 0, 768, 0, 20, 0, 10, 0]);
  assert.equal(object.controller.air.enabled, 1);
  call(0x1f, [1]);
  call(0x18, [0, 0, 2, 0, 64, 64, 2]);
  assert.equal(particles.variants.snowImages[0].durationSpread, -1024);
  call(0x1a, [1, 0, 1, 2, 64, 32, 1, 128]);
  call(0x1b, [1, 0, 64]);
  assert.equal(particles.variants.specialOptions[0], 64);
  call(0x20, [handle, 0, 1, 11]);
  call(0x24, [1, 0]);
  call(0x25, [0, 0, 10 * 65536, 0, 65536, 0, 0, 0, 0, 0, 0x10000000]);
  assert.equal(particles.variants.snowParameters[0][10], 256);
  call(0x28, [handle, 0, 1, 13]);
  call(0x29, [handle, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  call(0x2c, [0, 1]);
  call(0x2d, [0, 100, 0, 0, 10 * 65536, 0, 65536, 0, 0, 0, 0, 0, 2, 0, 0x10000000, 3, 4, 0x20]);
  assert.equal(particles.variants.fireflyParameters[0][14], 256);
  assert.equal(particles.variants.fireflyParameters[0][17], 0x20);
  assert.equal(object.controller.targetCounts[0], 1);
  assert.equal(object.controller.spawnIntervals[64], 13);
  call(0x01, [handle]);
  assert.equal(manager.categoryCount(6), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(visited.size, 24);
});
