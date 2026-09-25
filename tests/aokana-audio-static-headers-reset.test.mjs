import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';

test('F52B0 clears every static header under the existing engine lock 2', async () => {
  const allocator = new AokanaDistributedAllocator(1),
    locks = new AokanaNativeLocks(allocator),
    channels = new AokanaAudioChannels(
      new AokanaSpeakerContext(new AokanaMemorySpeakerBackend(1000)),
      locks,
      allocator,
      new AokanaSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    );
  locks.initializeEngine();
  try {
    channels.staticHeaders.fill(0xa5);
    channels.staticHeadersInitialized.fill(0);
    channels.streamMaster[0] = 37;
    channels.staticMaster[127] = 83;
    const actor = {};
    locks.enterEngine(2);
    let pending;
    try {
      pending = channels.clearStaticHeaders(actor);
      assert.equal(channels.staticHeaders[0], 0xa5);
      assert.equal(channels.staticHeaders.at(-1), 0xa5);
      assert.equal(channels.staticHeadersInitialized[0], 0);
    } finally {
      locks.leaveEngine(2);
    }
    await pending;
    assert.equal(channels.staticHeaders.length, 128 * 64);
    assert.ok(channels.staticHeaders.every((byte) => byte === 0));
    assert.ok(channels.staticHeadersInitialized.every((byte) => byte === 1));
    assert.equal(channels.streamMaster[0], 37);
    assert.equal(channels.staticMaster[127], 83);
  } finally {
    locks.disposeEngine();
    locks.engine.dispose();
    locks.script.dispose();
    allocator.dispose();
  }
});
