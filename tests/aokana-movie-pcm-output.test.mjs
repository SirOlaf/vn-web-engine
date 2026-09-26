import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMemoryMoviePcmOutput} from '../dist/engines/buriko/games/aokana/native/movie-pcm-output.js';
import {aokanaIsoTime} from '../dist/engines/buriko/games/aokana/native/movie-iso-timeline.js';
const f = aokanaIsoTime.fraction;
const span = (values, rate, start, editIndex) => ({
  planes: [Float32Array.from(values)],
  sampleRate: rate,
  frameCount: values.length,
  firstFrame: 0,
  endFrame: values.length,
  editIndex,
  start,
  end: aokanaIsoTime.add(start, f(BigInt(values.length), BigInt(rate))),
});
test('movie PCM core consumes committed gaps, overlaps and resampled actual planes across transport changes', () => {
  const output = new AokanaMemoryMoviePcmOutput({channels: 1, capacityFrames: 8}, 4);
  const complete = [],
    progress = [];
  output.onComplete((status) => complete.push(status));
  output.onProgress((status) => progress.push(status));
  const command = (value) => output.command({generation: 0, ...value});
  command({kind: 'enqueue', span: span([0.25, 0.75], 2, f(1n, 2n), 0)});
  command({kind: 'enqueue', span: span([0.5], 2, f(1n), 1)});
  command({kind: 'enqueue', span: span([0.875], 2, f(1n), 1)});
  assert.equal(command({kind: 'status'}).retainedFrames, 4);
  command({kind: 'commit', through: f(1n, 2n)});
  command({kind: 'gain', decibels: 2000 * Math.log10(0.5)});
  command({kind: 'end', position: f(11n, 8n)});
  assert.equal(complete.length, 0);
  command({kind: 'run'});
  assert.deepEqual(
    output.render(2).map((p) => [...p]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.deepEqual(command({kind: 'status'}).position, f(1n, 2n));
  command({kind: 'pause'});
  assert.deepEqual(
    output.render(2).map((p) => [...p]),
    [
      [0, 0],
      [0, 0],
    ],
  );
  assert.deepEqual(command({kind: 'status'}).position, f(1n, 2n));
  command({kind: 'run'});
  const rendered = output.render(4);
  for (const plane of rendered) assert.deepEqual([...plane], [0.125, 0.25, 0.25, 0.25]);
  assert.equal(complete.length, 1);
  assert.deepEqual(complete[0].position, f(11n, 8n));
  assert.equal(complete[0].consumedFrames, 6n);
  output.render(2);
  assert.equal(complete.length, 1);
  // A normal acknowledged seek drops retained overhang, resets coverage and restarts output origin.
  assert.equal(command({kind: 'flush', generation: 1, position: f(2n)}).retainedFrames, 0);
  command({kind: 'enqueue', generation: 1, span: span([1], 4, f(2n), 0)});
  command({kind: 'end', generation: 1, position: f(9n, 4n)});
  command({kind: 'run', generation: 1});
  assert.deepEqual(
    output.render(1).map((p) => [...p]),
    [[0.5], [0.5]],
  );
  assert.equal(complete.length, 2);
  assert.equal(progress.at(-1).generation, 1);
  assert.equal(progress.at(-1).retainedFrames, 0);
  command({kind: 'dispose', generation: 1});
});
