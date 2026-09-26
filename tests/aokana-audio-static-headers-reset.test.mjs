import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoAudioChannels} from '../dist/engines/buriko/native/audio/channel-registry.js';
import {BurikoSpeakerContext} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';

test('F52B0 clears every static header under the existing engine lock 2', async () => {
  const allocator = new BurikoDistributedAllocator(1),
    locks = new BurikoNativeLocks(allocator),
    channels = new BurikoAudioChannels(
      new BurikoSpeakerContext(new BurikoMemorySpeakerBackend(1000)),
      locks,
      allocator,
      new BurikoSystemTicks({now: () => 0}),
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
