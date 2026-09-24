import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
function wave(frames) {
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
const close = (actual, expected) =>
  assert.ok(actual.every((value) => Math.abs(value - expected) < 1e-7));
test('actual16/128 registry shares engine2 admission and drives PCM master, mute restoration and raw-tick fades', async () => {
  const main = {},
    worker = {},
    actors = {currentActor: main};
  const locks = new AokanaNativeLocks(actors);
  locks.initializeEngine();
  let milliseconds = 0;
  const ticks = new AokanaSystemTicks({now: () => milliseconds}),
    backend = new AokanaMemorySpeakerBackend(1000);
  const channels = new AokanaAudioChannels(
    new AokanaSpeakerContext(backend),
    locks,
    actors,
    ticks,
    {prefer24Bit: false},
  );
  const window = {};
  assert.equal(channels.initialize(window), 0);
  assert.equal(channels.window, window);
  assert.equal(channels.stream.length, 16);
  assert.equal(channels.static.length, 128);
  assert.equal(channels.activate(), 0);
  try {
    await channels.initializeMasters();
    assert.equal(await channels.attachStatic(0, wave(1000), 0, 1, 1), 0);
    assert.equal(await channels.attachStream(0, wave(3000), 128, 64, 1), 0);
    assert.equal(channels.static[0].active, 1);
    assert.equal(channels.stream[0].active, 1);
    assert.equal(channels.stream[0].levels.additional, 128);
    // Normal synchronous owner and recursive async entry share the same native record.
    locks.enterEngine(2);
    await locks.enterEngineAsync(2, main);
    const changed = channels.setPersistentMaster(false, 0, 74, worker);
    let record = locks.engine.snapshot().find((record) => record.id === locks.engineId(2));
    assert.equal(record.owner, main);
    assert.equal(record.admitted, 3);
    assert.equal(record.acquired, 2);
    assert.equal(channels.staticMaster[0], 74);
    locks.leaveEngine(2);
    locks.leaveEngine(2);
    await changed;
    record = locks.engine.snapshot().find((record) => record.id === locks.engineId(2));
    assert.equal(record.owner, null);
    assert.equal(record.admitted, 0);
    assert.equal(record.acquired, 0);
    assert.equal(await channels.startStatic(0, 128, 64), 0);
    close(backend.buffers[0].render(8)[0], 0.05);
    await channels.mute();
    close(backend.buffers[0].render(8)[0], 0);
    await channels.setPersistentMaster(false, 0, 128);
    assert.equal(channels.static[0].levels.master, 0);
    await channels.unmute();
    close(backend.buffers[0].render(8)[0], 0.5);
    assert.equal(channels.staticMaster[0], 128);
    assert.equal(
      await channels.stream[0].speaker.start(channels.stream[0].levels.attenuation()),
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await channels.fadeStream(0, 74, 100), 0);
    milliseconds = 50;
    await channels.dispatchTimer();
    channels.checkTimer();
    assert.equal(channels.stream[0].levels.volume.current, 101);
    close(backend.buffers[1].render(100)[0], 0.158113883);
    await new Promise((resolve) => setTimeout(resolve, 0));
    milliseconds = 100;
    await channels.dispatchTimer();
    channels.checkTimer();
    assert.equal(channels.stream[0].levels.volume.active, false);
    close(backend.buffers[1].render(100)[0], 0.05);
    await new Promise((resolve) => setTimeout(resolve, 0));
    channels.stream[0].speaker.checkWorker();
  } finally {
    await channels.disposeChannels();
  }
  assert.equal(channels.flags, 0);
  assert.equal(channels.stream.length, 0);
  assert.equal(channels.static.length, 0);
});
