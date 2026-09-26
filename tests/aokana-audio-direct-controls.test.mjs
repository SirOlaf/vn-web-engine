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
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {createGroupA0AudioControls} from '../dist/engines/buriko/native/group-a0-audio-controls.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
test('A0 direct controls drive actual attached PCM voices through shared locks and raw fade timer', async () => {
  const actors = {currentActor: {}},
    locks = new BurikoNativeLocks(actors);
  locks.initializeEngine();
  let milliseconds = 0;
  const backend = new BurikoMemorySpeakerBackend(1000);
  const channels = new BurikoAudioChannels(
    new BurikoSpeakerContext(backend),
    locks,
    actors,
    new BurikoSystemTicks({now: () => milliseconds}),
    {prefer24Bit: false},
  );
  assert.equal(channels.initialize({}), 0);
  assert.equal(channels.activate(), 0);
  const slots = createGroupA0AudioControls(channels, {
    threadFatal() {
      assert.fail('ordinary control fixture');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(16)), diagnostics: {}};
  const invoke = async (secondary, args) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.deepEqual(
      [slot.primary, slot.nativeAddress],
      [0xa0, BURIKO_NATIVE_SLOT_ADDRESSES[0xa0][secondary]],
    );
    args.forEach((value) => push32(thread, value));
    assert.equal(await slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const tick = async (value) => {
    milliseconds = value;
    await channels.dispatchTimer();
    channels.checkTimer();
  };
  try {
    await channels.initializeMasters();
    await channels.attachStatic(0, wave(1000), 0, 1, 1);
    await channels.attachStream(0, wave(3000), 128, 64, 1);
    await channels.startStatic(0, 128, 64);
    await channels.stream[0].speaker.start(channels.stream[0].levels.attenuation());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await invoke(0x14, [0, 1]); // Valid resume request through the real stream virtual.
    await invoke(0x17, [0, 64]);
    const initial = backend.buffers[1].render(8);
    close(initial[0], 0.5);
    close(initial[1], 0.5);
    await invoke(0x16, [0, 74, 100]);
    await tick(50);
    close(backend.buffers[1].render(8)[0], 0.158113883);
    await tick(100);
    close(backend.buffers[1].render(8)[0], 0.05);
    await invoke(0x16, [0, 128, 0]);
    await tick(100);
    await invoke(0x19, [0, 100]);
    await tick(200);
    close(backend.buffers[1].render(8)[0], 0);
    await invoke(0x18, [0, 100]);
    await tick(300);
    close(backend.buffers[1].render(8)[0], 0.5);
    await invoke(0x1c, [0, 74]);
    close(backend.buffers[1].render(8)[0], 0.05);
    assert.equal(channels.streamMaster[0], 128);
    await invoke(0x2c, [0, 74]);
    close(backend.buffers[0].render(8)[0], 0.05);
    assert.equal(channels.staticMaster[0], 128);
    await invoke(0x26, [0, 100]);
    await tick(400);
    close(backend.buffers[0].render(8)[0], 0);
    await invoke(0x25, [0]);
    assert.equal(await channels.static[0].speaker.status(), 0);
    close(backend.buffers[0].render(8)[0], 0);
    channels.stream[0].speaker.checkWorker();
  } finally {
    await channels.disposeChannels();
  }
});
