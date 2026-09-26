import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {
  BurikoMovieImage,
  BurikoMovieImageConfiguration,
} from '../dist/engines/buriko/native/movie-image.js';
import {
  BurikoMovieMediaGraph,
  BurikoMovieRenderer,
} from '../dist/engines/buriko/native/movie-renderer.js';
import {BurikoMovieRegistry} from '../dist/engines/buriko/native/movie-registry.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';

class Video extends EventTarget {
  currentTime = 0;
  duration = 1;
  volume = 1;
  calls = [];
  onPause = () => {};
  play() {
    assert.fail('Retirement fixture must not start media playback');
  }
  pause() {
    this.onPause();
    this.calls.push('pause');
  }
  removeAttribute(name) {
    this.calls.push(`remove:${name}`);
  }
  load() {
    this.calls.push('load');
  }
}

test('surface slot replacement retires each HTML graph after registry unlink and owns its join', async () => {
  const surfaces = new BurikoSurfaces(
      null,
      new BurikoBitmapCompositor(),
      new BurikoDistributedAllocator(1),
    ),
    registry = new BurikoMovieRegistry();
  surfaces.attachMovies(registry);
  const attach = (slot) => {
    assert.equal(surfaces.allocate(slot, 2, 2, 1), 1);
    const video = new Video(),
      graph = new BurikoMovieMediaGraph(video, URL.createObjectURL(new Blob())),
      renderer = new BurikoMovieRenderer(
        surfaces,
        slot,
        new BurikoMovieImage(new BurikoMovieImageConfiguration()),
        new BurikoNativeNotifications(),
      ),
      id = registry.append(renderer);
    renderer.attachGraph(graph, 0, id);
    surfaces.record(slot).movieId = id;
    video.onPause = () => {
      assert.equal(registry.find(id), null);
      assert.equal(registry.hasPendingRetirement(slot), true);
      assert.equal(surfaces.descriptor(slot), null);
    };
    return {id, renderer, video};
  };

  const first = attach(3);
  assert.equal(first.id, 0);
  assert.equal(surfaces.release(3), 1);
  assert.equal(surfaces.record(3).movieId, -1);
  assert.equal(first.renderer.initialized, false);
  assert.equal(registry.hasPendingRetirement(3), true);
  assert.deepEqual(first.video.calls, ['pause', 'remove:src', 'load']);
  await registry.joinSlotRetirements(3);
  assert.equal(registry.hasPendingRetirement(3), false);

  const second = attach(4);
  assert.equal(second.id, 1);
  assert.equal(surfaces.allocate(4, 3, 3, 1), 1);
  assert.equal(surfaces.record(4).movieId, -1);
  assert.equal(surfaces.descriptor(4).width, 3);
  assert.equal(registry.hasPendingRetirement(4), true);
  assert.deepEqual(second.video.calls, ['pause', 'remove:src', 'load']);
  await registry.joinAllRetirements();
  assert.equal(registry.hasPendingRetirement(4), false);
  assert.equal(
    registry.append(
      new BurikoMovieRenderer(
        surfaces,
        5,
        new BurikoMovieImage(new BurikoMovieImageConfiguration()),
        new BurikoNativeNotifications(),
      ),
    ),
    2,
  );
  registry.clear();
  await registry.joinAllRetirements();
});
