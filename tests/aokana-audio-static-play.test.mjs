import test from 'node:test';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {createGroupA0StaticPlay} from '../dist/engines/buriko/games/aokana/native/group-a0-static-play.js';
import assert from 'node:assert/strict';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaAudioStaticResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-static.js';

test('A0:24 starts registered initialized PCM and pushes its actual duration through the BP stack', async () => {
  const bytes = new Uint8Array(72),
    header = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    header.setUint32(offset, value, true);
  [0, 16384, 0, -16384].forEach((value, index) => header.setInt16(64 + index * 2, value, true));
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
    resources = new AokanaAudioStaticResources(channels),
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
    [slot] = createGroupA0StaticPlay(resources, errors),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0});
  const duration = async () => {
    for (const value of [0, 128, 64]) push32(thread, value);
    assert.equal(await slot.execute({thread, actor: actors.currentActor}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  assert.equal(slot.primary, 0xa0);
  assert.equal(slot.secondary, 0x24);
  assert.equal(slot.nativeAddress, 0x1400e5420);
  channels.initialize({});
  channels.activate();
  try {
    await channels.initializeMasters();
    assert.equal(
      await resources.register(0, {bytes, offset: 0}, 0, 1, 1, new Uint8Array(72).fill(1)),
      0,
    );
    //4 source frames /1000Hz *1000ms, with the persistent speed1 coefficient65536.
    assert.equal(await duration(), 4);
    assert.equal(new DataView(channels.staticHeaders.buffer).getUint32(60, true), 65536);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
    assert.equal(await channels.releaseStatic(0), 0);
  } finally {
    await channels.disposeChannels();
  }
});
