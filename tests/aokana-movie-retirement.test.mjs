import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {
  AokanaMovieImage,
  AokanaMovieImageConfiguration,
} from '../dist/engines/buriko/games/aokana/native/movie-image.js';
import {
  AokanaMovieMediaGraph,
  AokanaMovieRenderer,
} from '../dist/engines/buriko/games/aokana/native/movie-renderer.js';
import {AokanaMovieRegistry} from '../dist/engines/buriko/games/aokana/native/movie-registry.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';

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
  const surfaces = new AokanaSurfaces(
      null,
      new AokanaBitmapCompositor(),
      new AokanaDistributedAllocator(1),
    ),
    registry = new AokanaMovieRegistry();
  surfaces.attachMovies(registry);
  const attach = (slot) => {
    assert.equal(surfaces.allocate(slot, 2, 2, 1), 1);
    const video = new Video(),
      graph = new AokanaMovieMediaGraph(video, URL.createObjectURL(new Blob())),
      renderer = new AokanaMovieRenderer(
        surfaces,
        slot,
        new AokanaMovieImage(new AokanaMovieImageConfiguration()),
        new AokanaNativeNotifications(),
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
      new AokanaMovieRenderer(
        surfaces,
        5,
        new AokanaMovieImage(new AokanaMovieImageConfiguration()),
        new AokanaNativeNotifications(),
      ),
    ),
    2,
  );
  registry.clear();
  await registry.joinAllRetirements();
});
