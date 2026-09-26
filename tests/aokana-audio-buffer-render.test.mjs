import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaAudioBufferRenderCore} from '../dist/engines/buriko/games/aokana/native/audio/buffer-render-core.js';
import {createAokanaWaveStatic} from '../dist/engines/buriko/games/aokana/native/audio/wave-static.js';
import {
  AokanaAudioLevels,
  aokanaAudioVolumeDecibels,
} from '../dist/engines/buriko/games/aokana/native/audio-levels.js';

const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-7, `${index}: ${value} != ${expected[index]}`),
  );
};
test('actual WaveBox PCM feeds the worklet render core with attenuation, cursor notifications and mutable ring writes', async () => {
  const wave = new Uint8Array(72),
    header = new DataView(wave.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 24000],
    [20, 1],
    [48, 1],
  ])
    header.setUint32(offset, value, true);
  [0, 16384, 0, -16384].forEach((value, index) => header.setInt16(64 + index * 2, value, true));
  const model = await createAokanaWaveStatic(wave, {gain: 1, prefer24Bit: false}),
    pcm = new Uint8Array(8);
  assert.equal(model.readInto(pcm, 0, 4), 4);
  const core = new AokanaAudioBufferRenderCore(
      {
        sampleRate: model.sampleRate,
        channels: model.channels,
        bits: model.outputBits,
        byteLength: pcm.length,
      },
      48000,
    ),
    levels = new AokanaAudioLevels();
  levels.master = 74;
  levels.additional = 128;
  levels.volume.current = 128;
  levels.envelope.current = 128;
  assert.equal(levels.attenuation(), 20);
  core.command({kind: 'write', offset: 0, bytes: pcm, initialized: new Uint8Array(8).fill(1)});
  core.command({kind: 'notifications', offsets: [0, 4, 0xffffffff]});
  core.command({kind: 'volume', decibels: aokanaAudioVolumeDecibels(levels.attenuation())});
  core.command({kind: 'pan', decibels: 2000});
  assert.deepEqual(core.command({kind: 'play', loop: false}), {
    playing: true,
    byteCursor: 0,
    renderFrame: 0,
  });
  const output = [new Float32Array(8), new Float32Array(8)];
  core.render(output);
  close(output[0], [0, 0.0025, 0.005, 0.0025, 0, -0.0025, -0.005, -0.005]);
  close(output[1], [0, 0.025, 0.05, 0.025, 0, -0.025, -0.05, -0.05]);
  assert.deepEqual(core.command({kind: 'status'}), {playing: false, byteCursor: 0, renderFrame: 8});
  assert.deepEqual(core.takeNotifications(), [
    {index: 0, offset: 0, renderFrame: 0},
    {index: 1, offset: 4, renderFrame: 4},
    {index: 2, offset: 0xffffffff, renderFrame: 8},
  ]);
  // Publish a normal split ring lock: final sample8192 and first sample16384.
  core.command({
    kind: 'write',
    offset: 6,
    bytes: Uint8Array.of(0, 32, 0, 64),
    initialized: Uint8Array.of(1, 1, 1, 1),
  });
  core.command({kind: 'seek', byteOffset: 6});
  core.command({kind: 'play', loop: true});
  const loop = [new Float32Array(4), new Float32Array(4)];
  core.render(loop);
  close(loop[0], [0.0025, 0.00375, 0.005, 0.005]);
  close(loop[1], [0.025, 0.0375, 0.05, 0.05]);
  assert.deepEqual(core.command({kind: 'status'}), {playing: true, byteCursor: 2, renderFrame: 12});
  core.command({kind: 'stop'});
  assert.deepEqual(core.takeNotifications(), [
    {index: 0, offset: 0, renderFrame: 10},
    {index: 2, offset: 0xffffffff, renderFrame: 12},
  ]);
  core.command({kind: 'dispose'});
  model.dispose();
});
