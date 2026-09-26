import test from 'node:test';
import assert from 'node:assert/strict';
import {mapBurikoMovieAudioEdit} from '../dist/engines/buriko/native/movie-audio-samples.js';
import {BurikoMemoryMoviePcmOutput} from '../dist/engines/buriko/native/movie-pcm-output.js';
import {BurikoMoviePcmGraphClock} from '../dist/engines/buriko/native/movie-pcm-clock.js';
import {
  createBurikoIsoTimeline,
  burikoIsoTime,
} from '../dist/engines/buriko/native/movie-iso-timeline.js';

test('aligned real mapped PCM consumes trailing silent coverage through a common movie stop', () => {
  const f = burikoIsoTime.fraction,
    track = {
      timescale: 4,
      duration: 4n,
      movieDuration: 4n,
      samples: [{compositionTime: 0n, duration: 4}],
      edits: [{duration: 4n, mediaTime: 0n, rate: 65536}],
    },
    timeline = createBurikoIsoTimeline({timescale: 4}, track),
    commonStop = {policy: 'retain-frame-support', stop: f(2n)},
    span = mapBurikoMovieAudioEdit(
      {
        planes: [Float32Array.from([1 / 4, 1 / 2, -1 / 4, -1 / 2])],
        sampleRate: 4,
        frameCount: 4,
        mediaStart: f(0n),
      },
      track,
      timeline.edits[0],
    );
  assert.notEqual(span, null);
  assert.deepEqual(span.end, timeline.exactDuration);
  const output = new BurikoMemoryMoviePcmOutput({channels: 1, capacityFrames: 4}, 4),
    clock = new BurikoMoviePcmGraphClock(output),
    completed = [];
  const remove = output.onComplete((status) => completed.push(status.position));
  const command = (value) => output.command({generation: 0, ...value});
  try {
    command({kind: 'enqueue', span});
    // Last output-grid point before2s is7/4. No synthetic silent samples are enqueued.
    command({kind: 'commit', through: f(7n, 4n)});
    command({kind: 'run'});
    const first = output.render(7);
    assert.deepEqual([...first[0]], [1 / 4, 1 / 2, -1 / 4, -1 / 2, 0, 0, 0]);
    assert.deepEqual([...first[1]], [...first[0]]);
    assert.equal(clock.now(), 17500000n);
    assert.equal(completed.length, 0);
    command({kind: 'end', position: commonStop.stop});
    const last = output.render(1);
    assert.deepEqual([...last[0]], [0]);
    assert.deepEqual([...last[1]], [0]);
    assert.equal(clock.now(), 20000000n);
    assert.equal(output.acknowledgedStatus.consumedFrames, 8n);
    assert.equal(output.acknowledgedStatus.retainedFrames, 0);
    assert.deepEqual(completed, [commonStop.stop]);
  } finally {
    remove();
    command({kind: 'dispose'});
  }
});
