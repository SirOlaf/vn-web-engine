import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function pcm() {
  const bytes = new Uint8Array(64 + 5000 * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 10000],
    [12, 5000],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  for (let index = 0; index < 5000; index++) view.setInt16(64 + index * 2, 16384, true);
  return bytes;
}

test('mounted A0 stream loads use the shared inactive WaveBox music owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, core, child, definitions, memory, invoke, encode} = fixture;
  const {resource} = graph;
  const backend = resource.channels.context.backend;
  try {
    assert.ok(backend instanceof AokanaMemorySpeakerBackend);
    assert.equal(resource.music.resources, resource.resources);
    assert.equal(resource.music.streams, resource.streams);
    assert.equal(resource.streams.channels, resource.channels);
    assert.equal(resource.streams.cache, resource.archiveCache);
    assert.equal(resource.streams.files, resource.files);
    assert.equal(resource.audio.music, resource.music);
    assert.equal(resource.worker.audio, resource.audio);
    assert.equal(core.worker, resource.worker);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xa0 && [0x10, 0x11, 0x12].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x10, 0x11, 0x12],
    );

    const wave = pcm();
    assert.equal(await resource.files.write(encode('C:\\game\\loose.bw'), wave), wave.length);
    memory.globalMemory.set(encode('unused.arc'), 0x100);
    memory.globalMemory.set(encode('loose.bw'), 0x180);
    await graph.start({automatic: false});

    assert.equal(await invoke(0xa0, 0x10, [0, 0x180, 128], 0), 0);
    assert.equal(resource.channels.stream[0].active, 1);
    assert.ok(resource.channels.stream[0].model);
    assert.equal(resource.channels.stream[0].speaker.ready, true);

    // Same-name pair reuses one real loose PCM stream and selects the raw loop mode.
    assert.equal(await invoke(0xa0, 0x12, [1, 0, 0x180, 0x180, 1, 96, 64], 0), 0);
    assert.equal(resource.channels.stream[1].active, 1);
    assert.equal(resource.channels.stream[1].model.wave.loopEnabled, 2);
    assert.equal(resource.channels.stream[1].levels.volume.current, 96);

    assert.equal(await invoke(0xa0, 0x11, [2, 0x100, 0x180, 100, 64], 0), 0);
    assert.equal(resource.channels.stream[2].active, 1);
    assert.ok(resource.channels.stream[2].model);
    assert.equal(core.control.asynchronousResourceLoads, 0);

    assert.equal(await invoke(0x80, 0x53, [], 0), 0);
    assert.equal(core.control.asynchronousResourceLoads, 1);
    assert.equal(await invoke(0xa0, 0x11, [3, 0x100, 0x180, 80, 64], 2), 0);
    assert.equal(core.control.asynchronousResourceLoads, 0);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(resource.audio.hasMusic, true);
    assert.equal(await resource.worker.processOne(), 'music');
    assert.equal(resource.audio.hasMusic, false);
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(child.process, null);
    assert.equal(resource.channels.stream[3].active, 1);
    assert.ok(resource.channels.stream[3].model);

    assert.equal(child.state.stackIndex, 0);
    assert.equal(resource.loading.activeProcedures, 0);
    assert.equal(backend.buffers.length, 4);
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(resource.channels.stream[channel].speaker.ready, true);
      assert.equal(backend.buffers[channel].core.status().playing, false);
    }
    await fixture.close();
    assert.equal(resource.channels.stream.length, 0);
    assert.equal(resource.channels.flags, 0);
  } finally {
    await fixture.close();
  }
});
