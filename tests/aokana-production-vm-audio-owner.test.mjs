import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function pcm(frames) {
  const bytes = new Uint8Array(64 + frames * 2);
  const view = new DataView(bytes.buffer);
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

test('mounted A0 volume, status, and release callbacks share inactive graph PCM owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, core, child, definitions, memory, diagnostics} = fixture;
  const channels = graph.resource.channels;
  const backend = channels.context.backend;
  const find = (secondary) => {
    const definition = definitions.find(
      ({primary, secondary: value}) => primary === 0xa0 && value === secondary,
    );
    assert.ok(definition);
    return definition;
  };
  const callAsync = async (secondary, args, pushed = 0) => {
    for (const value of args) push32(child.state, value);
    const result = find(secondary).execute({thread: child.state, memory, diagnostics});
    assert.ok(result instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const joined = core.joinPendingNativeCallbacks();
    assert.equal(await result, 0);
    await joined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(child.state.stackIndex, pushed);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(channels.locks, graph.manager.locks);
    assert.equal(channels.actors, graph.allocator);
    assert.equal(channels.ticks, graph.ticks);
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.ok(backend instanceof AokanaMemorySpeakerBackend);
    assert.deepEqual(
      definitions.filter(({primary}) => primary === 0xa0).map(({secondary}) => secondary),
      [0, 8, 9, 0x15, 0x22, 0x1c, 0x2c, 0x10, 0x11, 0x12, 0x20, 0x21, 0x23, 0x27, 0x28, 0x2f],
    );
    await graph.start({automatic: false});
    assert.equal(channels.flags & 3, 3);
    assert.equal(channels.streamMaster[0], 128);
    assert.equal(channels.staticMaster[0], 128);
    assert.equal(await channels.attachStream(0, pcm(1000), 128, 64, 1), 0);
    assert.equal(await channels.attachStatic(0, pcm(1000), 0, 1, 1), 0);
    assert.equal(channels.stream[0].active, 1);
    assert.equal(channels.static[0].active, 1);
    assert.equal(backend.buffers.length, 2);
    assert.equal(backend.buffers[0].core.status().playing, false);
    assert.equal(backend.buffers[1].core.status().playing, false);
    const volumeCommands = [[], []];
    for (const [index, buffer] of backend.buffers.entries()) {
      const command = buffer.command.bind(buffer);
      buffer.command = async (value) => {
        if (value.kind === 'volume') volumeCommands[index].push(value.decibels);
        return command(value);
      };
    }

    await callAsync(0x08, [0, 74]);
    await callAsync(0x09, [0, 91]);
    await callAsync(0x1c, [0, 64]);
    await callAsync(0x2c, [0, 64]);
    assert.deepEqual([channels.streamMaster[0], channels.staticMaster[0]], [74, 91]);
    assert.deepEqual(
      [
        channels.stream[0].levels.master,
        channels.stream[0].levels.additional,
        channels.static[0].levels.master,
        channels.static[0].levels.additional,
      ],
      [74, 64, 91, 64],
    );
    assert.equal(channels.stream[0].speaker.attenuation, -4400);
    assert.equal(channels.static[0].speaker.attenuation, -3700);
    assert.equal(volumeCommands[0].at(-1), -4400);
    assert.equal(volumeCommands[1].at(-1), -3700);
    assert.equal(backend.buffers[0].core.status().playing, false);
    assert.equal(backend.buffers[1].core.status().playing, false);

    const view = new DataView(memory.globalMemory.buffer);
    view.setInt32(0x300, 77, true);
    await callAsync(0x15, [0, 0x300], 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(view.getInt32(0x300, true), 0);
    channels.staticHeaders.fill(0xa5, 0, 64);
    channels.staticHeadersInitialized.fill(0, 0, 64);
    await callAsync(0x22, [0]);
    assert.equal(channels.static[0].active, 0);
    assert.equal(channels.static[0].model, null);
    assert.equal(channels.static[0].speaker.ready, false);
    assert.deepEqual([...channels.staticHeaders.subarray(0, 64)], Array(64).fill(0));
    assert.deepEqual([...channels.staticHeadersInitialized.subarray(0, 64)], Array(64).fill(1));

    const constant = find(0).execute({thread: child.state, memory, diagnostics});
    assert.equal(constant, 0);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 20);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
