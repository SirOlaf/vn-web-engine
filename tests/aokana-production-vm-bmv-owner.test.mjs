import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function encodedFrame(alpha) {
  const header = new Uint8Array(200);
  const view = new DataView(header.buffer);
  header[0] = header[16] = 1;
  const row = [1, 192, 1, 0, 0, 0];
  view.setUint32(192, 200, true);
  view.setUint32(196, 200 + row.length, true);
  const samples = Array.from({length: 8}, () => [0, ...new Array(8).fill(alpha)]).flat();
  return Uint8Array.from([...header, ...row, ...samples]);
}

function encodedMovie() {
  const frame = encodedFrame(170);
  const movie = new Uint8Array(200 + frame.length);
  const view = new DataView(movie.buffer);
  movie.set(new TextEncoder().encode('BF_Movie_______\0'));
  view.setUint32(0x10, 0x10000, true);
  view.setUint32(0x14, 8, true);
  view.setUint32(0x18, 8, true);
  view.setUint32(0x1c, 32, true);
  view.setUint32(0x20, 1, true);
  view.setUint32(0x24, 40, true);
  view.setUint32(0x28, 1, true);
  movie.fill(1, 0x40, 0xc0);
  view.setUint32(0xc0, 200, true);
  movie.set(frame, 200);
  return movie;
}

test('mounted BMV load, alias, partial source and sync/async frame work share graph owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, memory, definitions, encode, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const name = 0x200;
  const fullHandle = 0x300;
  const partialHandle = 0x304;
  const aliasHandle = 0x308;
  const metadata = 0x320;
  try {
    assert.equal(graph.bmvRegistry.allocator, graph.allocator);
    assert.equal(graph.bmvService.registry, graph.bmvRegistry);
    assert.equal(graph.bmvService.surfaces, graph.surfaces);
    assert.equal(graph.bmvService.ranges, graph.resource.loading.ranges);
    assert.equal(graph.bmvService.synchronous, graph.resource.processing);
    assert.equal(graph.bmvService.asynchronous, graph.bmvAsyncProcessing);
    assert.notEqual(graph.bmvAsyncProcessing, graph.resource.processing);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0x90 && [0xf4, 0xf5, 0xf6, 0xf7].includes(secondary)) ||
            (primary === 0x92 && secondary === 0xf1),
        )
        .map(({primary, secondary}) => `${primary.toString(16)}:${secondary.toString(16)}`),
      ['90:f4', '90:f5', '90:f7', '90:f6', '92:f1'],
    );

    const movie = encodedMovie();
    await graph.resource.files.write(encode('C:\\game\\sample.bmv'), movie);
    memory.globalMemory.set(new TextEncoder().encode('sample.bmv\0'), name);
    await graph.start({automatic: false});
    assert.equal(graph.surfaces.allocate(0, 8, 8, 1), 1);

    await invoke(0x90, 0xf4, [fullHandle, metadata, 0, name], 2);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(await graph.resource.worker.processOne(), 'resource');
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    const full = view.getUint32(fullHandle, true);
    assert.equal(graph.bmvRegistry.find(full).resource.bytes.length, movie.length);

    await invoke(0x90, 0xf7, [aliasHandle, full], 0);
    assert.equal(pop32(child.state), 0);
    const alias = view.getUint32(aliasHandle, true);
    assert.equal(graph.bmvRegistry.find(alias).resource, graph.bmvRegistry.find(full).resource);
    await invoke(0x90, 0xf5, [alias], 0);
    assert.equal(pop32(child.state), 0);

    await invoke(0x92, 0xf1, [partialHandle, metadata, 0, name, 1], 2);
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(await graph.resource.worker.processOne(), 'resource');
    assert.equal(await child.pollProcess(false), 0);
    assert.equal(await graph.resource.worker.processOne(), 'resource');
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    const partial = view.getUint32(partialHandle, true);
    assert.equal(graph.bmvRegistry.find(partial).resource.provenance.length, movie.length);

    await invoke(0x90, 0xf6, [0, partial, 0], 0);
    assert.equal(pop32(child.state), 0);
    graph.surfaces.descriptor(0).storage.range(0, 8 * 8 * 4, true);

    await invoke(0x80, 0x53, [], 0);
    await invoke(0x90, 0xf6, [0, full, 0], 2);
    await graph.bmvPump.joinAccepted();
    assert.equal(await child.pollProcess(false), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(graph.resource.loading.activeProcedures, 0);
  } finally {
    await fixture.close();
  }
});
