import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaAudioStaticResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-static.js';

test('static registration publishes actual PCM and persistent native duration consumed by a speaker', async () => {
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
    resources = new AokanaAudioStaticResources(channels);
  channels.initialize({});
  channels.activate();
  try {
    await channels.initializeMasters();
    assert.equal(
      await resources.register(0, {bytes, offset: 0}, 0, 1, 1, new Uint8Array(72).fill(1)),
      0,
    );
    //4 source frames /1000Hz *1000ms, with the persistent speed1 coefficient65536.
    assert.equal(await resources.duration(0), 4);
    assert.equal(new DataView(channels.staticHeaders.buffer).getUint32(60, true), 65536);
    assert.equal(await channels.startStatic(0, 128, 64), 0);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
    assert.equal(await channels.releaseStatic(0), 0);
    assert.equal(await resources.duration(0), 0);
  } finally {
    await channels.disposeChannels();
  }
});
