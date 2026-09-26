import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {createGroupA0AudioMasters} from '../dist/engines/buriko/games/aokana/native/group-a0-audio-masters.js';

function pcm(frames) {
  const bytes = new Uint8Array(64 + frames * 2),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, frames * 2],
    [12, frames],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  for (let index = 0; index < frames; index++) view.setInt16(64 + index * 2, 16384, true);
  return bytes;
}
const samplesEqual = (samples, expected) =>
  assert.ok(samples.every((value) => Math.abs(value - expected) < 1e-7));

test('A0 master opcodes consume actual BP arguments and change real static and stream PCM', async () => {
  const actors = {currentActor: {}},
    locks = new AokanaNativeLocks(actors);
  locks.initializeEngine();
  const backend = new AokanaMemorySpeakerBackend(1000),
    channels = new AokanaAudioChannels(
      new AokanaSpeakerContext(backend),
      locks,
      actors,
      new AokanaSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    ),
    text = new AokanaNativeText(),
    files = new AokanaProgramFiles(
      new StoredFileSystem(new MemoryStore()),
      text,
      new AokanaProgramMedia(),
    ),
    errors = new AokanaEngineErrors(
      files,
      new AokanaEngineDialogs(),
      text.encodeWide('/save/', 1),
      text.encodeWide('/', 1),
    ),
    slots = createGroupA0AudioMasters(channels, errors),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 64, frameCapacity: 0});
  const invoke = async (secondary, args = []) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((slot) => slot.secondary === secondary).execute({thread}), 0);
  };
  assert.equal(channels.initialize({}), 0);
  assert.equal(channels.activate(), 0);
  try {
    await channels.initializeMasters();
    await channels.attachStatic(0, pcm(1000), 0, 1, 1);
    await channels.attachStream(0, pcm(3000), 128, 64, 1);
    await channels.startStatic(0, 128, 64);
    await channels.stream[0].speaker.start(channels.stream[0].levels.attenuation());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await invoke(0);
    assert.equal(pop32(thread), 20);
    await invoke(8, [0, 74]);
    assert.equal(channels.streamMaster[0], 74);
    samplesEqual(backend.buffers[1].render(8)[0], 0.05);
    await invoke(9, [0, 128]);
    samplesEqual(backend.buffers[0].render(8)[0], 0.5);
    await channels.mute();
    await invoke(9, [0, 74]);
    assert.equal(channels.staticMaster[0], 74);
    assert.equal(channels.static[0].levels.master, 0);
    samplesEqual(backend.buffers[0].render(8)[0], 0);
    await channels.unmute();
    samplesEqual(backend.buffers[0].render(8)[0], 0.05);
    assert.equal(thread.stackIndex, 0);
    channels.stream[0].speaker.checkWorker();
  } finally {
    await channels.disposeChannels();
  }
});
