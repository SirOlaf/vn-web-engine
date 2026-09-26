import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('0405C0 releases every fixed surface slot in order under one actor', () => {
  const allocator = new BurikoDistributedAllocator(1),
    fonts = new BurikoNativeFonts(new BurikoNativeText()),
    surfaces = new BurikoSurfaces(fonts, new BurikoBitmapCompositor(), allocator),
    actor = {},
    originalActor = allocator.currentActor,
    visited = [];
  for (const index of [0, 7, 0x3fff]) assert.equal(surfaces.allocate(index, 1, 1, 1), 1);
  const release = surfaces.release.bind(surfaces);
  surfaces.release = (index) => {
    assert.equal(allocator.currentActor, actor);
    visited.push(index);
    return release(index);
  };

  surfaces.releaseAllForProgram(actor);

  assert.deepEqual(
    visited,
    Array.from({length: 0x4000}, (_, index) => index),
  );
  for (const index of [0, 7, 0x3fff]) {
    assert.equal(surfaces.descriptor(index), null);
    assert.equal(surfaces.imageId(index), -1);
  }
  assert.equal(allocator.currentActor, originalActor);
  fonts.dispose();
  allocator.dispose();
});
