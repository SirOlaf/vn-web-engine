import test from 'node:test';
import assert from 'node:assert/strict';
import {mapBurikoMovieAudioEdit} from '../dist/engines/buriko/native/movie-audio-samples.js';
import {BurikoMemoryMoviePcmOutput} from '../dist/engines/buriko/native/movie-pcm-output.js';
import {
  createBurikoIsoTimeline,
  burikoIsoTime,
} from '../dist/engines/buriko/native/movie-iso-timeline.js';

test('single actual edits feed copied PCM through real overlap arbitration and output EOS', () => {
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
  const timeline = createBurikoIsoTimeline({timescale: 16}, track);
  const f = burikoIsoTime.fraction;
  const chunk = {
    planes: [
      Float32Array.from([0, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8]),
      Float32Array.from([0, -1 / 8, -1 / 4, -3 / 8, -1 / 2, -5 / 8, -3 / 4, -7 / 8]),
    ],
    sampleRate: 4,
    frameCount: 8,
    mediaStart: f(1n, 8n),
  };
  const first = mapBurikoMovieAudioEdit(chunk, track, timeline.edits[1]);
  const repeated = mapBurikoMovieAudioEdit(chunk, track, timeline.edits[2]);
  assert.notEqual(first, null);
  assert.notEqual(repeated, null);
  assert.deepEqual(
    [first.firstFrame, first.endFrame, repeated.firstFrame, repeated.endFrame],
    [1, 4, 2, 4],
  );
  assert.deepEqual(
    [first.start, first.end, repeated.start, repeated.end],
    [f(1n, 4n), f(1n), f(15n, 16n), f(23n, 16n)],
  );
  const output = new BurikoMemoryMoviePcmOutput({channels: 2, capacityFrames: 8}, 4);
  const command = (value) => output.command({generation: 0, ...value});
  command({kind: 'enqueue', span: first});
  command({kind: 'enqueue', span: repeated});
  command({kind: 'end', position: timeline.exactDuration});
  command({kind: 'run'});
  // At1s repeated edit index is1/4: 1/4+(3/8-1/4)/4=9/32. Its last frame holds.
  const planes = output.render(6);
  assert.deepEqual([...planes[0]], [0, 1 / 8, 1 / 4, 3 / 8, 9 / 32, 3 / 8]);
  assert.deepEqual([...planes[1]], [0, -1 / 8, -1 / 4, -3 / 8, -9 / 32, -3 / 8]);
  assert.deepEqual(output.acknowledgedStatus.position, f(21n, 16n));
  assert.equal(output.acknowledgedStatus.consumedFrames, 6n);
  assert.equal(output.acknowledgedStatus.ended, true);
  command({kind: 'dispose'});
});
