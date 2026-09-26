import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaParticleController,
  sortAokanaParticlesByDepth,
} from '../dist/engines/buriko/games/aokana/native/particle-controller.js';
import {AokanaParticleVariants} from '../dist/engines/buriko/games/aokana/native/particle-images.js';
import {AokanaThreadedCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {
  allocateAokanaBitmap,
  fillAokanaBitmap,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

function fixture(workerCount = 3) {
  let tick = 100;
  const allocator = new AokanaDistributedAllocator(workerCount);
  const processing = new AokanaDistributedProcessing(allocator, workerCount);
  const random = new AokanaThreadedCrtRandom(() => allocator.currentActor);
  const variants = new AokanaParticleVariants();
  const image = allocateAokanaBitmap(32, 32, 2);
  fillAokanaBitmap(image, 0xff112233);
  variants.configureImages('snow', 0, [image], 1, 0, 0);
  variants.configureSnow(0, [0, 10 * 65536, 0, 65536, 0, 0, 0, 0, 0, 0]);
  const controller = new AokanaParticleController(
    variants,
    random,
    new AokanaNativeClock(() => tick),
    new AokanaBitmapCompositor(),
    processing,
  );
  return {
    controller,
    processing,
    random,
    allocator,
    setTick: (value) => {
      tick = value;
    },
  };
}

test('particle controller updates existing instances before deadline-based spawning and warm-up', () => {
  const {controller: c, setTick} = fixture();
  assert.equal(c.setTarget(0, 0, 3, 10), 0);
  c.update(100);
  assert.equal(c.activeCount, 1);
  assert.equal(c.previousTick, 110);
  assert.equal(c.nextSpawnTicks[0], 110);
  c.update(105);
  assert.equal(c.particleAt(0).position().x, 0);
  c.update(110);
  assert.equal(c.activeCount, 2);
  assert.deepEqual([c.particleAt(0).position().x, c.particleAt(1).position().x], [256, 0]);
  c.update(135);
  assert.equal(c.activeCount, 3);
  assert.deepEqual(
    [0, 1, 2].map((i) => c.particleAt(i).position().x),
    [768, 512, 0],
  );
  assert.equal(c.previousTick, 140);
  assert.equal(c.nextSpawnTicks[0], 0);
  setTick(135);
  c.warmUp(10);
  assert.deepEqual(
    [0, 1, 2].map((i) => c.particleAt(i).position().x),
    [1024, 768, 256],
  );
  assert.equal(c.previousTick, 140);
  assert.equal(c.nextSpawnTicks[0], 0);
  c.clear();
  assert.equal(c.activeCount, 0);
  assert.equal(c.targetCounts[0], 3);
  assert.equal(c.spawnIntervals[0], 10);
  c.update(145);
  assert.equal(c.activeCount, 1);
  assert.equal(c.nextSpawnTicks[0], 155);
});

test('particle controller resets overdue scheduling and retains the independent zero-interval pause', () => {
  const {controller: c} = fixture();
  c.setTarget(0, 0, 4, 10);
  c.update(100);
  c.update(1000);
  assert.equal(c.previousTick, 1010);
  assert.equal(c.activeCount, 2);
  assert.equal(c.nextSpawnTicks[0], 1010);
  assert.deepEqual([c.particleAt(0).position().x, c.particleAt(1).position().x], [256, 0]);
  assert.equal(c.setInterval(0), true);
  c.update(2000);
  assert.equal(c.previousTick, 1010);
  assert.equal(c.activeCount, 2);
  assert.equal(c.air.interval, 0);
});

test('particle projection and actual worker drawing preserve camera rotation, layer depth and damage', () => {
  const {controller: c} = fixture();
  c.setTarget(0, 0, 1, 0);
  c.update(100);
  assert.equal(c.configureCamera(0, 0, -100 * 65536, 0, 0, 90 * 65536, 100), true);
  const projected = c.project();
  assert.deepEqual(
    projected.map(({x, y, z}) => ({x, y, z})),
    [{x: -2560, y: 0, z: 25600}],
  );
  const front = allocateAokanaBitmap(64, 64, 2),
    rear = allocateAokanaBitmap(64, 64, 2);
  fillAokanaBitmap(front, 0);
  fillAokanaBitmap(rear, 0);
  const damage = c.draw([front, rear], [25599, 25600], 32, 32);
  assert.deepEqual(damage, [{left: 19, top: 24, right: 34, bottom: 39}]);
  assert.equal(bitmapRead32(front, 24 * front.stride + 19 * 4), 0);
  assert.equal(bitmapRead32(rear, 24 * rear.stride + 19 * 4), 0xff112233);
  assert.equal(bitmapRead32(rear, 39 * rear.stride + 34 * 4), 0xff112233);
  assert.equal(bitmapRead32(rear, 40 * rear.stride + 35 * 4), 0);
  assert.equal(c.criticalSection.depth, 0);
});

test('native particle depth ordering retains equal-depth swaps', () => {
  const points = [5, 3, 5, 1, 3].map((z, tag) => ({x: 0, y: 0, z, particle: {tag}}));
  sortAokanaParticlesByDepth(points);
  assert.deepEqual(
    points.map((p) => p.z),
    [5, 5, 3, 3, 1],
  );
  assert.deepEqual(
    points.map((p) => p.particle.tag),
    [2, 0, 4, 1, 3],
  );
});

test('shared CRT random keeps the native main and background worker streams independent', () => {
  const {processing, random, allocator} = fixture();
  const main = allocator.currentActor;
  random.seed(1);
  assert.equal(random.next(), 41);
  const draws = [];
  processing.setWorkerCallback((_context, worker) => {
    draws.push({worker, value: random.next()});
    return 0;
  }, null);
  processing.run(1);
  processing.setWorkerCallback(null, null);
  assert.equal(allocator.currentActor, main);
  assert.deepEqual(
    draws.sort((a, b) => a.worker - b.worker),
    [
      {worker: 0, value: 18467},
      {worker: 1, value: 41},
      {worker: 2, value: 41},
    ],
  );
  assert.equal(random.next(), 6334);
});
