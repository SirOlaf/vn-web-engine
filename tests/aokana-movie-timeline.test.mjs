import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBurikoIsoTimeline,
  burikoIsoDecodeStart,
} from '../dist/engines/buriko/native/movie-iso-timeline.js';

const movie = {timescale: 1000};
const track = (edits = [], changes = {}) => ({
  timescale: 48000,
  movieDuration: 3000n,
  duration: 144000n,
  edits,
  samples: [0, 1, 2].map((index) => ({
    compositionTime: BigInt(index * 48000),
    duration: 48000,
    sync: index === 0 || index === 2,
  })),
  ...changes,
});

test('ISO edits preserve gaps, clipped sample boundaries and exact rational times', () => {
  const timeline = createBurikoIsoTimeline(
    movie,
    track([
      {duration: 250n, mediaTime: -1n, rate: 65536},
      {duration: 1500n, mediaTime: 24001n, rate: 65536},
    ]),
  );
  assert.equal(timeline.duration, 17500000n);
  assert.deepEqual(
    timeline.presentations.map(({sampleIndex, start, end}) => [sampleIndex, start, end]),
    [
      [0, 2500000n, 7499791n],
      [1, 7499791n, 17499791n],
      [2, 17499791n, 17500000n],
    ],
  );
  assert.deepEqual(timeline.presentations[0].mediaStart, {numerator: 24001n, denominator: 1n});
  assert.deepEqual(timeline.presentations[1].exactStart, {numerator: 35999n, denominator: 48000n});
  assert.deepEqual(timeline.presentations[2].mediaEnd, {numerator: 96001n, denominator: 1n});
});

test('ISO dwell, reverse and non-unit rates preserve actual source selection', () => {
  const timeline = createBurikoIsoTimeline(
    movie,
    track([
      {duration: 1000n, mediaTime: 72000n, rate: 0},
      {duration: 2000n, mediaTime: 96000n, rate: -65536},
      {duration: 1000n, mediaTime: 0n, rate: 131072},
    ]),
  );
  assert.deepEqual(
    timeline.presentations.map(({sampleIndex, start, end, rate}) => [
      sampleIndex,
      start,
      end,
      rate,
    ]),
    [
      [1, 0n, 10000000n, 0],
      [1, 10000000n, 20000000n, -65536],
      [0, 20000000n, 30000000n, -65536],
      [0, 30000000n, 35000000n, 131072],
      [1, 35000000n, 40000000n, 131072],
    ],
  );
  assert.deepEqual(timeline.presentations[1].mediaStart, {numerator: 96000n, denominator: 1n});
  assert.deepEqual(timeline.presentations[1].mediaEnd, {numerator: 48000n, denominator: 1n});
});

test('ISO unknown durations use sample extent and decode seeks retain keyframe preroll', () => {
  const source = track([], {movieDuration: 0n, duration: 0xffffffffffffffffn});
  assert.equal(createBurikoIsoTimeline(movie, source).duration, 30000000n);
  assert.equal(burikoIsoDecodeStart(source, 1), 0);
  assert.equal(burikoIsoDecodeStart(source, 2), 2);
  assert.throws(() => burikoIsoDecodeStart(source, 3), /outside/);
  assert.throws(
    () => burikoIsoDecodeStart({...source, samples: [{sync: false}]}, 0),
    /random-access/,
  );
});

test('ISO composition order is independent of decode order, and point samples remain points', () => {
  const timeline = createBurikoIsoTimeline(
    movie,
    track([], {
      timescale: 3,
      duration: 3n,
      movieDuration: 1000n,
      samples: [
        {compositionTime: 2n, duration: 1, sync: true},
        {compositionTime: 0n, duration: 1, sync: false},
        {compositionTime: 1n, duration: 0, sync: false},
      ],
    }),
  );
  assert.deepEqual(
    timeline.presentations.map(({sampleIndex, start, end}) => [sampleIndex, start, end]),
    [
      [1, 0n, 3333333n],
      [2, 3333333n, 3333333n],
      [0, 6666666n, 10000000n],
    ],
  );
});
