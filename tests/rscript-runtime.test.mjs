import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFsc} from '../dist/formats/rscript/fsc.js';
import {FramePlayer} from '../dist/engines/rscript/runtime/animation.js';
import {
  RScriptSoundChannel,
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

test('RScript streams fade at the native 20 ms per step', async () => {
  const ramps = [];
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    cancelScheduledValues() {},
    exponentialRampToValueAtTime: (value, time) => ramps.push(time),
  });
  const node = () => ({connect: (next) => next, disconnect() {}, gain: param(), pan: param()});
  const context = {
    currentTime: 0,
    createGain: node,
    createStereoPanner: node,
    createBuffer: (channels, length, rate) => ({duration: length / rate, copyToChannel() {}}),
    createBufferSource: () => ({...node(), start() {}, stop() {}}),
  };
  // A one-sample 16-bit mono PCM WAVE.
  const wave = Buffer.alloc(46);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(38, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(44100, 24);
  wave.writeUInt32LE(88200, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(2, 40);
  const channel = new RScriptSoundChannel(
    {context, read: async () => new Uint8Array(wave)},
    context.createGain(),
  );
  channel.load('Track01.wav');
  channel.play(false, -1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Fairytale Symphony stops the title music with 200 steps: four seconds.
  channel.fadeSteps = 200;
  channel.stop(true);
  assert.deepEqual(ramps, [4]);
});
