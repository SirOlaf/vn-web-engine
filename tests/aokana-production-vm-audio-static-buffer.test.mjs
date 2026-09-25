import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted static duration reads registered PCM from the shared inactive speaker', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const {resource} = graph;
  const backend = resource.channels.context.backend;
  try {
    assert.equal(resource.statics.channels, resource.channels);
    assert.equal(resource.channels.actors, graph.allocator);
    assert.equal(resource.channels.locks, graph.manager.locks);
    assert.equal(resource.errors.files, resource.files);
    assert.ok(backend instanceof AokanaMemorySpeakerBackend);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xa0 && [0x22, 0x28, 0x2f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x22, 0x28, 0x2f],
    );
    assert.equal(resource.worker.loading, resource.loading);
    assert.equal(resource.worker.audio, resource.audio);
    assert.equal(resource.audio.staticResources, resource.statics);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0xa0 && [0x20, 0x21, 0x23, 0x27, 0x28].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x20, 0x21, 0x23, 0x27, 0x28],
    );
    await graph.start({automatic: false});

    const source = new Uint8Array(72);
    const wave = new DataView(source.buffer);
    for (const [offset, value] of [
      [0, 64],
      [4, 0x20207762],
      [8, 8],
      [12, 4],
      [16, 1000],
      [20, 1],
      [48, 1],
    ])
      wave.setUint32(offset, value, true);
    [0, 16384, 0, -16384].forEach((value, index) => wave.setInt16(64 + index * 2, value, true));
    memory.globalMemory.set(source, 0x200);

    assert.equal(await invoke(0xa0, 0x28, [0, 0x200, 0, 65536, 65536], 2), 0);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(resource.audio.hasStatic, true);
    assert.equal(await resource.worker.processOne(), 'static');
    assert.equal(resource.audio.hasStatic, false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(resource.channels.static[0].active, 1);
    assert.equal(backend.buffers.length, 1);
    assert.equal(backend.buffers[0].core.status().playing, false);

    assert.equal(await invoke(0xa0, 0x2f, [0], 0), 1);
    assert.equal(pop32(child.state), 4);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(backend.buffers[0].core.status().playing, false);

    assert.equal(await invoke(0xa0, 0x22, [0], 0), 0);
    assert.equal(resource.channels.static[0].active, 0);
    assert.equal(resource.channels.static[0].model, null);
    assert.equal(resource.channels.static[0].speaker.ready, false);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

test('mounted A0 sound loads serially pass decoded PCM through the shared resource and static worker', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, invoke, encode} = fixture;
  const {resource} = graph;
  const backend = resource.channels.context.backend;
  try {
    assert.ok(backend instanceof AokanaMemorySpeakerBackend);
    assert.equal(resource.worker.loading, resource.loading);
    assert.equal(resource.worker.audio, resource.audio);
    assert.equal(resource.audio.staticResources, resource.statics);
    assert.equal(resource.statics.channels, resource.channels);

    const source = new Uint8Array(72);
    const wave = new DataView(source.buffer);
    for (const [offset, value] of [
      [0, 64],
      [4, 0x20207762],
      [8, 8],
      [12, 4],
      [16, 1000],
      [20, 1],
      [48, 1],
    ])
      wave.setUint32(offset, value, true);
    [0, 16384, 0, -16384].forEach((value, index) => wave.setInt16(64 + index * 2, value, true));
    assert.equal(await resource.files.write(encode('C:\\game\\voice.bw'), source), source.length);
    memory.globalMemory.set(encode('voice.bw'), 0x100);
    await graph.start({automatic: false});

    const cases = [
      {secondary: 0x20, channel: 0, args: [0, 0, 0x100], duration: 0, speed: 0, rateWord: 0},
      {
        secondary: 0x21,
        channel: 1,
        args: [1, 0, 0x100, 0, 65536],
        duration: 4,
        speed: 1,
        rateWord: 65536,
      },
      {
        secondary: 0x23,
        channel: 2,
        args: [2, 0, 0x100, 0, 65536],
        duration: 2,
        speed: 2,
        rateWord: 32768,
      },
      {
        secondary: 0x27,
        channel: 3,
        args: [3, 0, 0x100, 0, 65536, 32768],
        duration: 8,
        speed: 0.5,
        rateWord: 131072,
      },
    ];
    for (const {secondary, channel, args, duration, speed, rateWord} of cases) {
      assert.equal(await invoke(0xa0, secondary, args, 2), 0);
      assert.ok(child.process);
      assert.equal(resource.loading.hasPending, true);
      assert.equal(await resource.worker.processOne(), 'resource');
      assert.equal(resource.loading.hasPending, false);
      assert.deepEqual(child.process.output.bytes, source);
      assert.equal(child.process.output.initialized, undefined);

      assert.equal(await child.pollProcess(false), 0);
      assert.equal(resource.audio.hasStatic, true);
      assert.equal(await resource.worker.processOne(), 'static');
      assert.equal(resource.audio.hasStatic, false);
      assert.equal(await child.pollProcess(false), 1);
      assert.equal(child.process, null);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(resource.channels.static[channel].active, 1);
      assert.equal(resource.channels.static[channel].speaker.rate, speed);
      assert.equal(
        new DataView(resource.channels.staticHeaders.buffer).getUint32(channel * 64 + 60, true),
        rateWord,
      );
      assert.deepEqual(
        [...resource.channels.staticHeadersInitialized.subarray(channel * 64, channel * 64 + 64)],
        Array(64).fill(1),
      );
      assert.equal(backend.buffers.at(-1).core.status().playing, false);

      assert.equal(await invoke(0xa0, 0x2f, [channel], 0), 1);
      assert.equal(pop32(child.state), duration);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(await invoke(0xa0, 0x22, [channel], 0), 0);
      assert.equal(resource.channels.static[channel].active, 0);
      assert.equal(resource.channels.static[channel].speaker.ready, false);
      assert.equal(child.state.stackIndex, 0);
    }
    assert.equal(child.process, null);
    assert.equal(resource.loading.hasPending, false);
    assert.equal(resource.audio.hasStatic, false);
  } finally {
    await fixture.close();
  }
});
