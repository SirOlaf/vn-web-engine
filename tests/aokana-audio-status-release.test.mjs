import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoSpeakerContext} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoAudioChannels} from '../dist/engines/buriko/native/audio/channel-registry.js';
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
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {createGroupA0AudioStatusRelease} from '../dist/engines/buriko/native/group-a0-audio-status-release.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
test('A0 queries the actual playing stream and loop output then releases an actual static voice', async () => {
  const actors = {currentActor: {}},
    locks = new BurikoNativeLocks(actors);
  locks.initializeEngine();
  const backend = new BurikoMemorySpeakerBackend(1000);
  const channels = new BurikoAudioChannels(
    new BurikoSpeakerContext(backend),
    locks,
    actors,
    new BurikoSystemTicks({now: () => 0}),
    {prefer24Bit: false},
  );
  channels.initialize({});
  channels.activate();
  const slots = createGroupA0AudioStatusRelease(channels, {
    threadFatal() {
      assert.fail('ordinary status fixture');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(64)),
    context = {thread, memory, diagnostics: {}};
  const invoke = async (secondary, args) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.deepEqual(
      [slot.primary, slot.nativeAddress],
      [0xa0, BURIKO_NATIVE_SLOT_ADDRESSES[0xa0][secondary]],
    );
    args.forEach((v) => push32(thread, v));
    assert.equal(await slot.execute(context), 0);
    const result = secondary === 0x15 ? pop32(thread) : undefined;
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  try {
    await channels.initializeMasters();
    await channels.attachStatic(0, wave(1000), 0, 1, 1);
    await channels.attachStream(0, wave(3000), 128, 64, 1);
    await channels.startStatic(0, 128, 64);
    await channels.stream[0].speaker.start(channels.stream[0].levels.attenuation());
    await new Promise((resolve) => setTimeout(resolve, 0));
    close(backend.buffers[0].render(8)[0], 0.5);
    close(backend.buffers[1].render(8)[0], 0.5);
    new DataView(memory.globalMemory.buffer).setInt32(16, 77, true);
    assert.equal(await invoke(0x15, [0, 16]), 1);
    assert.equal(new DataView(memory.globalMemory.buffer).getInt32(16, true), 0);
    assert.equal(await invoke(0x15, [0, 0]), 1);
    await invoke(0x22, [0]);
    assert.equal(channels.static[0].active, 0);
    assert.equal(channels.static[0].model, null);
    assert.equal(channels.static[0].speaker.ready, false);
    channels.stream[0].speaker.checkWorker();
  } finally {
    await channels.disposeChannels();
  }
});
