import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoMovieRegistry} from '../dist/engines/buriko/native/movie-registry.js';
import {BurikoMovieFramePosition} from '../dist/engines/buriko/native/movie-frame-position.js';

test('frame query reads the persisted position from an ordinary allocated surface', () => {
  const surfaces = new BurikoSurfaces(
    null,
    new BurikoBitmapCompositor(),
    new BurikoDistributedAllocator(1),
  );
  const movies = new BurikoMovieRegistry();
  surfaces.attachMovies(movies);
  assert.throws(
    () => new BurikoMovieFramePosition(surfaces, new BurikoMovieRegistry()),
    /attached surface movie registry/,
  );
  assert.equal(surfaces.allocate(7, 2, 2, 1), 1);
  const record = surfaces.record(7);
  assert.equal(record.movieId, -1);
  record.frame = 37;
  assert.deepEqual(new BurikoMovieFramePosition(surfaces, movies).read(7), {
    found: true,
    frame: 37,
  });
});
