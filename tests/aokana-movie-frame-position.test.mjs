import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaMovieRegistry} from '../dist/engines/buriko/games/aokana/native/movie-registry.js';
import {AokanaMovieFramePosition} from '../dist/engines/buriko/games/aokana/native/movie-frame-position.js';

test('frame query reads the persisted position from an ordinary allocated surface', () => {
  const surfaces = new AokanaSurfaces(
    null,
    new AokanaBitmapCompositor(),
    new AokanaDistributedAllocator(1),
  );
  const movies = new AokanaMovieRegistry();
  surfaces.attachMovies(movies);
  assert.throws(
    () => new AokanaMovieFramePosition(surfaces, new AokanaMovieRegistry()),
    /attached surface movie registry/,
  );
  assert.equal(surfaces.allocate(7, 2, 2, 1), 1);
  const record = surfaces.record(7);
  assert.equal(record.movieId, -1);
  record.frame = 37;
  assert.deepEqual(new AokanaMovieFramePosition(surfaces, movies).read(7), {
    found: true,
    frame: 37,
  });
});
