import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaAudioFade,
  AokanaAudioLevels,
  aokanaAudioPan,
  aokanaAudioPanDecibels,
  aokanaAudioVolumeDecibels,
} from '../dist/engines/buriko/games/aokana/native/audio-levels.js';
import {
  AokanaCdAudio,
  aokanaCdMode,
  createAokanaCdSlots,
} from '../dist/engines/buriko/games/aokana/native/cd-audio.js';
import {AokanaBpThread, push32, pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

const medium = () => {
  const sources = [];
  const context = {
    currentTime: 0,
    createBufferSource() {
      const source = {
        connect() {},
        disconnect() {},
        stop() {
          this.stopped = true;
        },
        start(...args) {
          this.started = args;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return {
    context,
    destination: {},
    tracks: [750, 1500].map((frames) => ({
      frames,
      pcm: {sampleRate: 44100, numberOfChannels: 2, length: frames * 588},
    })),
    sources,
  };
};

test('native fade crosses DWORD rollover with signed differences and finishes on the terminal update', () => {
  const fade = new AokanaAudioFade();
  fade.current = 128;
  fade.begin(0xfffffff0, 32, 0);
  fade.update(0);
  assert.equal(fade.current, 64);
  assert.equal(fade.active, true);
  fade.update(16);
  assert.equal(fade.current, 0);
  assert.equal(fade.active, false);
  fade.current = 10;
  fade.begin(100, 20, 30);
  fade.update(90);
  assert.equal(fade.current, 0, 'native interpolation permits a negative fraction');
});

test('nonpositive signed fade durations finish immediately and preserve CVTTSD2SI overflow', () => {
  const fade = new AokanaAudioFade();
  fade.current = 0x7fffffff;
  fade.begin(1, 0, -1);
  fade.update(1);
  assert.equal(fade.current, -1);
  fade.current = -0x80000000;
  fade.begin(1, 1, 0x7fffffff);
  fade.update(2);
  assert.equal(fade.current, -0x80000000);
});

test('four native level factors use attenuation with the original double divisor', () => {
  const levels = new AokanaAudioLevels();
  levels.master = levels.additional = levels.volume.current = levels.envelope.current = 128;
  assert.equal(levels.attenuation(), 0);
  levels.volume.current = 64;
  assert.equal(levels.attenuation(), 24);
  levels.envelope.current = 0;
  assert.equal(levels.attenuation(), 128);
  levels.envelope.current = 128;
  levels.volume.begin(10, 10, 128);
  assert.equal(levels.update(20), true);
  assert.equal(levels.update(21), false);
  assert.equal(levels.attenuation(), 0);
});

test('DirectSound output uses cubic pan and wrapped attenuation in hundredths of a decibel', () => {
  assert.deepEqual(
    [-100, 0, 32, 64, 96, 128, 300].map(aokanaAudioPan),
    [-128, -128, -64, 0, 64, 128, 128],
  );
  assert.deepEqual(
    [-128, -64, 0, 64, 128].map(aokanaAudioPanDecibels),
    [-10000, -1250, 0, 1250, 10000],
  );
  assert.equal(aokanaAudioVolumeDecibels(24), -2400);
  assert.equal(aokanaAudioVolumeDecibels(128), -10000);
  assert.equal(aokanaAudioVolumeDecibels(-1), 100);
  assert.equal(aokanaAudioVolumeDecibels(0x40000000), 0);
});

test('CD unavailable paths preserve output memory, while mode mappings retain all seven native values', () => {
  assert.deepEqual(
    Array.from({length: 7}, (_, i) => aokanaCdMode(0x20c + i)),
    [0, 3, 2, 6, 1, 4, 5],
  );
  assert.equal(aokanaCdMode(0), 0xffffffff);
  const cd = new AokanaCdAudio(null);
  assert.equal(cd.open(), false);
  assert.equal(cd.close(), false);
  assert.equal(cd.playTrack(1, true), false);
  assert.equal(cd.status, null);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 4,
    moduleCapacity: 4,
    frameCapacity: 4,
  });
  const memory = new AokanaBpMemory();
  push32(thread, 0);
  const status = createAokanaCdSlots(cd).find((slot) => slot.secondary === 0x86);
  status.execute({thread, memory});
  assert.equal(pop32(thread), 0, 'null output is not dereferenced when no device exists');
});

test('CD track notification repeats through the native successful-notification path', () => {
  const source = medium();
  const cd = new AokanaCdAudio(source);
  assert.equal(cd.open(), true);
  assert.equal(cd.open(), true);
  assert.equal(cd.playTrack(1, true), true);
  assert.deepEqual(source.sources[0].started, [0, 0, 10]);
  assert.equal(cd.status, 2);
  source.context.currentTime = 10;
  source.sources[0].onended();
  assert.equal(source.sources.length, 2);
  assert.deepEqual(source.sources[1].started, [10, 0, 10]);
  cd.stop();
  assert.equal(source.sources[1].onended, null);
  assert.equal(cd.status, 3);
});

test('CD failed play preserves active playback but records request; pause aborts completion repeat', () => {
  const source = medium();
  const cd = new AokanaCdAudio(source);
  cd.open();
  cd.playTrack(1, true);
  assert.equal(
    cd.playTrack(2, false),
    false,
    'native explicit track+1 endpoint is beyond last track',
  );
  assert.equal(cd.lastRequestedTrack, 2);
  assert.equal(cd.status, 2);
  source.context.currentTime = 2;
  assert.equal(cd.pause(), true);
  assert.equal(cd.status, 3, 'Windows CD driver reports stopped while paused');
  assert.equal(cd.positionTmsf, 1 | (2 << 16));
  assert.equal(cd.resume(), true);
  assert.deepEqual(source.sources[1].started, [2, 2, 8]);
  source.context.currentTime = 10;
  source.sources[1].onended();
  assert.equal(cd.status, 3);
  assert.equal(source.sources.length, 2, 'pause aborts the original notify request');
  assert.equal(cd.resume(), false);
});

test('CD TMSF seek uses 75-frame coordinates and rejects out-of-disc endpoints', () => {
  const source = medium();
  const cd = new AokanaCdAudio(source);
  cd.open();
  const position = 2 | (1 << 16) | (37 << 24);
  assert.equal(cd.seekTmsf(position), true);
  assert.equal(cd.positionTmsf, position >>> 0);
  assert.equal(cd.playTmsf(position, 2 | (2 << 16)), true);
  assert.deepEqual(source.sources[0].started, [0, 112 / 75, 38 / 75]);
  assert.equal(cd.seekTmsf(3), false);
  assert.equal(cd.close(), true);
  assert.equal(cd.positionTmsf, null);
});

test('zero-length CD notification replay yields to host tasks and can be cancelled', async () => {
  const source = medium();
  source.tracks[0].pcm = null;
  const cd = new AokanaCdAudio(source);
  cd.open();
  assert.equal(cd.playTrack(1, true), true, 'data-track skipping produces equal audio endpoints');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cd.stop(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cd.status, 3);
  assert.equal(source.sources.length, 0);
});

test('selected CD host leases the active medium across open, close, reopen, and VM disposal', () => {
  const first = medium();
  const second = medium();
  second.tracks[0].frames = 375;
  second.tracks[0].pcm.length = 375 * 588;
  const available = [null, first, second];
  const events = [];
  let opens = 0;
  const cd = new AokanaCdAudio({
    open() {
      events.push('open');
      const selected = available[opens++];
      return selected === null
        ? null
        : {
            medium: selected,
            release() {
              events.push('release');
              assert.equal(selected.sources.at(-1)?.stopped, true);
              assert.equal(selected.sources.at(-1)?.onended, null);
            },
          };
    },
  });
  assert.equal(cd.open(), false);
  assert.equal(cd.status, null);
  assert.equal(cd.open(), true);
  assert.equal(cd.open(), true, 'an open device keeps its existing lease');
  assert.equal(cd.playTrack(1, true), true);
  assert.equal(cd.close(), true);
  assert.equal(cd.close(), false);
  assert.equal(cd.open(), true);
  assert.equal(cd.playTrack(1, false), true);
  assert.deepEqual(second.sources[0].started, [0, 0, 5]);
  cd.dispose();
  cd.dispose();
  assert.equal(cd.status, null);
  assert.equal(cd.open(), false);
  assert.deepEqual(events, ['open', 'open', 'release', 'open', 'release']);
});
