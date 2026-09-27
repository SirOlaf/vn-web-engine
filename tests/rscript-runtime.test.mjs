import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFsc} from '../dist/formats/rscript/fsc.js';
import {FramePlayer} from '../dist/engines/rscript/runtime/animation.js';
import {
  attenuationGain,
  scriptLoops,
  volumeAttenuation,
} from '../dist/engines/rscript/runtime/audio.js';

test('RScript frame players run FSC scripts one displayed tick at a time', () => {
  const script = Buffer.from(
    [':begin', '?800 99 end', '0', '.', '1', '>begin', ':end', '-'].join('\n'),
  );
  const animation = {
    frames: [
      {surface: null, x: 0, y: 0},
      {surface: null, x: 0, y: 0},
    ],
    code: parseFsc(script),
  };
  const player = new FramePlayer(animation);
  const variables = new Int16Array(1000);
  const frames = [];
  for (let i = 0; i < 5; i++) {
    player.step(
      (index) => variables[index],
      () => 0,
    );
    frames.push(player.frame);
  }
  assert.deepEqual(frames, [0, 0, 1, 0, 0]);
  variables[800] = 99;
  assert.equal(
    player.step(
      (index) => variables[index],
      () => 0,
    ),
    true,
  ); // shows frame 1
  assert.equal(
    player.step(
      (index) => variables[index],
      () => 0,
    ),
    false,
  ); // ends
  assert.equal(player.running, false);
  // Without a script the frames loop in order.
  const plain = new FramePlayer({frames: animation.frames, code: null});
  plain.step(
    () => 0,
    () => 0,
  );
  assert.equal(plain.frame, 1);
  plain.step(
    () => 0,
    () => 0,
  );
  assert.equal(plain.frame, 0);
});

test('RScript audio maps native volumes, pans and repeat counts', () => {
  assert.equal(volumeAttenuation(255), 0);
  assert.equal(volumeAttenuation(0), -3000);
  assert.equal(attenuationGain(0), 1);
  assert.ok(Math.abs(attenuationGain(-2000) - 0.1) < 1e-12);
  assert.deepEqual([0, 1, 3, 999].map(scriptLoops), [0, 0, 2, -1]);
});
