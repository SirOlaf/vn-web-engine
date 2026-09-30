import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFsc} from '../dist/formats/rscript/fsc.js';
import {FramePlayer} from '../dist/engines/rscript/runtime/animation.js';
import {readFile} from 'node:fs/promises';
import {
  RScriptSoundChannel,
  attenuationGain,
  scriptLoops,
  volumeAttenuation,
} from '../dist/engines/rscript/runtime/audio.js';
import {decodeVorbis} from '../dist/audio/vorbis-decoder.js';
import {rscriptFontCatalog} from '../dist/engines/rscript/browser/fonts.js';
import {decodeCp932, encodeCp932} from '../dist/engines/rscript/text.js';

test('RScript font catalog lists Shift-JIS fixed-pitch families by their Japanese names', () => {
  const name = (unicode, language) => ({id: 1, platform: 3, language, unicode});
  const face = (family, fixedPitch, pages, names = []) => ({
    family,
    fullName: family,
    postscriptName: family,
    data: {fixedPitch, codePageRanges: [pages, 0], names},
  });
  const sjis = 1 << 17,
    gb2312 = 1 << 18;
  const catalog = rscriptFontCatalog([
    face('MS Gothic', true, sjis | 1, [name('MS Gothic', 0x409), name('ＭＳ ゴシック', 0x411)]),
    // A collection's proportional faces and bold styles of listed families are left out.
    face('MS Gothic', false, sjis, [name('MS PGothic', 0x409), name('ＭＳ Ｐゴシック', 0x411)]),
    face('MS Gothic', true, sjis, [name('MS Gothic', 0x409), name('ＭＳ ゴシック', 0x411)]),
    face('Plain Mono', true, sjis),
    face('NSimSun', true, gb2312, [name('NSimSun', 0x409)]),
    face('Courier New', true, 1, [name('Courier New', 0x409)]),
    // Face names are LOGFONTA strings: code page 932 and at most 31 bytes.
    face('Hangul Mono', true, sjis, [name('한글 Mono', 0x409)]),
    face('Long', true, sjis, [name('あ'.repeat(16), 0x411)]),
  ]);
  assert.deepEqual(catalog, ['ＭＳ ゴシック', 'Plain Mono']);
});

test('RScript text encodes code page 932 for face names', () => {
  const bytes = encodeCp932('ＭＳ ゴシック Ab');
  assert.deepEqual(
    [...bytes],
    [
      0x82, 0x6c, 0x82, 0x72, 0x20, 0x83, 0x53, 0x83, 0x56, 0x83, 0x62, 0x83, 0x4e, 0x20, 0x41,
      0x62,
    ],
  );
  assert.equal(
    decodeCp932(encodeCp932('あぃウェ５＃―壱弐鶴亀ＡｂAb')),
    'あぃウェ５＃―壱弐鶴亀ＡｂAb',
  );
  assert.equal(encodeCp932('한'), null);
});

/** Web Audio stand-in that records buffers and the source schedule. */
function recordingContext() {
  const sources = [];
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    cancelScheduledValues() {},
    exponentialRampToValueAtTime() {},
  });
  const node = () => ({connect: (next) => next, disconnect() {}, gain: param(), pan: param()});
  return {
    sources,
    currentTime: 2,
    createGain: node,
    createStereoPanner: node,
    createBuffer(channels, length, sampleRate) {
      const planes = Array.from({length: channels}, () => new Float32Array(length));
      return {
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (i) => planes[i],
        copyToChannel: (data, i) => planes[i].set(data),
      };
    },
    createBufferSource() {
      const source = {...node(), buffer: null, loop: false, when: null, offset: 0, stopAt: null};
      source.start = (when, offset = 0) => Object.assign(source, {when, offset});
      source.stop = (when = 0) => (source.stopAt = when);
      sources.push(source);
      return source;
    },
  };
}

/** Wraps an Ogg stream as a Vorbis ACM WAVE, as RScript archives store it. */
function vorbisWave(ogg, channels, rate) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(0x6771, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt16LE(2 * channels, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(ogg.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, data, ogg]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([riff, body]));
}

test('RScript music streams chunks back to back, then loops the whole track', async () => {
  const ogg = await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url));
  const expected = await decodeVorbis(new Uint8Array(ogg));
  const context = recordingContext();
  const read = async () => vorbisWave(ogg, 1, expected.sampleRate);
  const chunking = {firstFrames: 1000, chunkFrames: 1000, playableFrames: 10000};
  const channel = new RScriptSoundChannel(
    {context, read},
    context.createGain(),
    undefined,
    chunking,
  );
  channel.load('Track06.wav');
  channel.play(false, -1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rate = expected.sampleRate,
    sources = context.sources;
  const whole = sources.at(-1);
  const chunks = sources.slice(0, -1);
  // The fixture decodes as one EOS-trimmed chunk; real tracks give many.
  assert.ok(chunks.length >= 1, 'the first playback starts on streamed chunks');
  // Chunks follow one another on exact frames and hold the decoded PCM in order.
  let at = 0;
  const played = new Float32Array(expected.frames);
  for (const chunk of chunks) {
    assert.equal(chunk.loop, false);
    assert.ok(Math.abs(chunk.when - (2 + at / rate)) < 1e-9);
    played.set(chunk.buffer.getChannelData(0), at);
    at += chunk.buffer.length;
  }
  // The whole track takes over at the first unscheduled frame and loops from its start.
  assert.equal(whole.buffer.length, expected.frames);
  assert.equal(whole.loop, true);
  assert.ok(Math.abs(whole.when - (2 + at / rate)) < 1e-9);
  assert.ok(Math.abs(whole.offset - (at % expected.frames) / rate) < 1e-9);
  played.set(whole.buffer.getChannelData(0).subarray(at), at);
  assert.deepEqual(played, expected.planes[0]);
  assert.deepEqual(whole.buffer.getChannelData(0), expected.planes[0]);

  // A second play needs no streaming; three passes stop after three durations.
  channel.play(false, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const again = context.sources.at(-1);
  assert.equal(context.sources.length, sources.length);
  assert.equal(again.offset, 0);
  assert.ok(Math.abs(again.stopAt - (2 + (3 * expected.frames) / rate)) < 1e-9);
  // Every scheduled source of the earlier playback was stopped.
  assert.ok(chunks.every((chunk) => chunk.stopAt !== null));

  // A fading stop ends every source of the playback at the end of the fade.
  channel.fadeSteps = 50;
  channel.stop(true);
  assert.ok(Math.abs(again.stopAt - 3) < 1e-9);
});

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
