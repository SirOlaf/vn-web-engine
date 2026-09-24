import test from 'node:test';
import assert from 'node:assert/strict';
import {mapAokanaMovieAudioSpan} from '../dist/engines/buriko/games/aokana/native/movie-audio-samples.js';
import {
  createAokanaIsoTimeline,
  aokanaIsoTime,
} from '../dist/engines/buriko/games/aokana/native/movie-iso-timeline.js';

test('actual decoded PCM planes map repeated unit-rate edits with exact frame-start boundaries', () => {
  const track = {
    timescale: 8,
    duration: 32n,
    movieDuration: 21n,
    samples: [{compositionTime: 0n, duration: 32}],
    edits: [
      {duration: 4n, mediaTime: -1n, rate: 65536},
      {duration: 9n, mediaTime: 3n, rate: 65536},
      {duration: 8n, mediaTime: 4n, rate: 65536},
    ],
  };
  const timeline = createAokanaIsoTimeline({timescale: 16}, track);
  const chunk = {
    planes: [
      Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      Float32Array.from([0, -1, -2, -3, -4, -5, -6, -7]),
    ],
    sampleRate: 4,
    frameCount: 8,
    mediaStart: aokanaIsoTime.fraction(1n, 8n),
  };
  const spans = mapAokanaMovieAudioSpan(chunk, track, timeline);
  assert.deepEqual(
    spans.map((s) => [s.firstFrame, s.endFrame, s.editIndex]),
    [
      [1, 4, 1],
      [2, 4, 2],
    ],
  );
  assert.deepEqual(
    spans.map((s) => s.planes.map((p) => [...p])),
    [
      [
        [1, 2, 3],
        [-1, -2, -3],
      ],
      [
        [2, 3],
        [-2, -3],
      ],
    ],
  );
  const f = aokanaIsoTime.fraction;
  assert.deepEqual(
    spans.map((s) => [s.start, s.end]),
    [
      [f(1n, 4n), f(1n)],
      [f(15n, 16n), f(23n, 16n)],
    ],
  );
  const sought = mapAokanaMovieAudioSpan(chunk, track, timeline, f(1n, 2n));
  assert.deepEqual(
    sought.map((s) => [...s.planes[0]]),
    [
      [2, 3],
      [2, 3],
    ],
  );
  assert.deepEqual(sought[0].start, f(1n, 2n));
  assert.deepEqual(sought[0].end, f(1n));
  assert.deepEqual(
    mapAokanaMovieAudioSpan(
      {planes: [Float32Array.of(8, 9)], sampleRate: 4, frameCount: 2, mediaStart: f(17n, 8n)},
      track,
      timeline,
    ),
    [],
  );
});
