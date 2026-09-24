import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMemoryMoviePcmOutput} from '../dist/engines/buriko/games/aokana/native/movie-pcm-output.js';
import {AokanaMoviePcmGraphClock} from '../dist/engines/buriko/games/aokana/native/movie-pcm-clock.js';
import {aokanaIsoTime} from '../dist/engines/buriko/games/aokana/native/movie-iso-timeline.js';

const f = aokanaIsoTime.fraction;
const span = (values, start) => ({
  planes: [Float32Array.from(values)],
  sampleRate: 3,
  frameCount: values.length,
  firstFrame: 0,
  endFrame: values.length,
  editIndex: 0,
  start,
  end: aokanaIsoTime.add(start, f(BigInt(values.length), 3n)),
});

test('PCM graph clock reads actual output position across rendering, pause and acknowledged seek', () => {
  const output = new AokanaMemoryMoviePcmOutput({channels: 1, capacityFrames: 4}, 3);
  const clock = new AokanaMoviePcmGraphClock(output);
  const command = (value) => output.command({generation: 0, ...value});
  assert.equal(clock.now(), 0n);
  command({kind: 'enqueue', span: span([0.25, 0.5, 0.75], f(0n))});
  command({kind: 'end', position: f(1n)});
  command({kind: 'run'});
  assert.deepEqual(
    output.render(1).map((plane) => [...plane]),
    [[0.25], [0.25]],
  );
  // Exact 1/3 second is truncated once to the native 100ns reference-time unit.
  assert.equal(clock.now(), 3333333n);
  command({kind: 'pause'});
  assert.deepEqual(
    output.render(2).map((plane) => [...plane]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.equal(clock.now(), 3333333n);
  command({kind: 'run'});
  assert.deepEqual(
    output.render(1).map((plane) => [...plane]),
    [[0.5], [0.5]],
  );
  assert.equal(clock.now(), 6666666n);

  command({kind: 'flush', generation: 1, position: f(7n, 5n)});
  // The same clock reads the newly acknowledged absolute origin without rebasing or caching.
  assert.equal(clock.now(), 14000000n);
  command({kind: 'enqueue', generation: 1, span: span([0.125], f(7n, 5n))});
  command({kind: 'end', generation: 1, position: f(26n, 15n)});
  command({kind: 'run', generation: 1});
  assert.deepEqual(
    output.render(1).map((plane) => [...plane]),
    [[0.125], [0.125]],
  );
  assert.equal(clock.now(), 17333333n);
  assert.equal(output.acknowledgedStatus.ended, true);
  command({kind: 'dispose', generation: 1});
});
