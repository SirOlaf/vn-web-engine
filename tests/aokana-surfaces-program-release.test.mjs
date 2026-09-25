import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('0405C0 releases every fixed surface slot in order under one actor', () => {
  const allocator = new AokanaDistributedAllocator(1),
    fonts = new AokanaNativeFonts(new AokanaNativeText()),
    surfaces = new AokanaSurfaces(fonts, new AokanaBitmapCompositor(), allocator),
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
