import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {createGroup90BmvFrame} from '../dist/engines/buriko/games/aokana/native/group-90-bmv-frame.js';
import {AokanaBmvService} from '../dist/engines/buriko/games/aokana/native/bmv-service.js';
import {AokanaVmControlState} from '../dist/engines/buriko/games/aokana/native/group-80-threads.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBmvRegistry} from '../dist/engines/buriko/games/aokana/native/bmv-registry.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);

function setup() {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(fs, text, media),
    allocator = new AokanaDistributedAllocator(1),
    unavailable = () => assert.fail('Successful synthetic resource service opened a diagnostic'),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: bytes('C:\\game\\'),
        secondaryRoot: bytes('C:\\disc\\'),
        secondaryMediaPath: 'C:\\disc\\',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media'),
        retryMessage: bytes('Insert'),
        quitConfirmation: bytes('Quit?'),
      },
      {show: unavailable},
      {fatal: unavailable, threadFatal: unavailable},
      new AokanaDistributedProcessing(allocator, 1),
    ),
    loading = new AokanaResourceLoadingState(resources),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(1024)),
    scheduler = new AokanaBpScheduler(thread, () => 1),
    procedures = new AokanaProcedureState(),
    clock = new AokanaNativeClock(() => 100),
    registry = new AokanaBmvRegistry(allocator),
    surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(text),
      new AokanaBitmapCompositor(),
      allocator,
    ),
    service = new AokanaBmvService(
      registry,
      surfaces,
      loading.ranges,
      new AokanaDistributedProcessing(allocator, 2),
      new AokanaDistributedProcessing(allocator, 2),
    ),
    control = new AokanaVmControlState(),
    slots = createGroup90BmvFrame(service, loading, scheduler, procedures, clock, control),
    context = {thread, memory, diagnostics: {}};
  let nextText = 32;
  return {
    loading,
    allocator,
    surfaces,
    service,
    control,
    thread,
    memory,
    scheduler,
    registry,
    slots,
    mount(path, data) {
      sources.attach(path, new BlobSource(new Blob([data])));
    },
    name(value) {
      const address = nextText;
      nextText += value.length + 16;
      memory.globalMemory.set(bytes(value + '\0'), address);
      return address;
    },
    async call(target, ...arguments_) {
      arguments_.forEach((value) => push32(target, value));
      return slots[0].execute({...context, thread: target});
    },
  };
}

function frame(version, color, alpha) {
  // Single-symbol DC/AC trees yield zero coefficients: neutral BGR128.
  const header = new Uint8Array(200),
    view = new DataView(header.buffer);
  header[0] = header[16] = 1;
  const row = color ? [1, 192, 1, 0, 0, 0] : [1, 0, 0, 0, 0];
  view.setUint32(192, 200, true);
  view.setUint32(196, 200 + row.length, true);
  const literals = Array.from({length: 8}, () => [0, ...new Array(8).fill(alpha)]).flat();
  return Uint8Array.from([
    ...header,
    ...row,
    ...(version === 0x10001 ? [1, 0, 0, 0] : []),
    ...literals,
  ]);
}
function movie(version) {
  const first = frame(version, true, 170),
    second = frame(version, false, 85),
    output = new Uint8Array(200 + first.length + second.length),
    view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('BF_Movie_______\0'));
  view.setUint32(0x10, version, true);
  view.setUint32(0x14, 8, true);
  view.setUint32(0x18, 8, true);
  view.setUint32(0x1c, 32, true);
  view.setUint32(0x20, 1, true);
  view.setUint32(0x24, 40, true);
  view.setUint32(0x28, 2, true);
  output.fill(1, 0x40, 0xc0);
  view.setUint32(0xc0, 200, true);
  view.setUint32(0xc4, 200 + first.length, true);
  output.set(first, 200);
  output.set(second, 200 + first.length);
  return output;
}

test('90 F6 uses actual surface bytes, range reads and serialized movie admission', async () => {
  const state = setup(),
    encoded = movie(0x10000),
    actor = state.allocator.currentActor;
  const register = (content, provenance = null) => {
    const output = new Uint8Array(4),
      metadata = new Uint8Array(20);
    assert.equal(
      state.registry.register(
        {bytes: output, offset: 0},
        {bytes: metadata, offset: 0},
        content,
        content.length,
        provenance,
      ),
      0,
    );
    return new DataView(output.buffer).getUint32(0, true);
  };
  const resident = register(encoded),
    partial = register(encoded.slice(0, 200), {
      archive: null,
      name: bytes('part.bmv'),
      length: encoded.length,
    });
  state.mount('/game/part.bmv', encoded);
  assert.equal(state.surfaces.allocate(0, 8, 8, 1), 1);
  assert.equal(state.surfaces.allocate(1, 8, 8, 1), 1);
  const assertPixels = (surface, alpha) => {
    const bitmap = state.surfaces.descriptor(surface);
    bitmap.storage.range(0, 256, true);
    for (let index = 0; index < 256; index += 4)
      assert.deepEqual(Array.from(bitmap.storage.bytes.subarray(index, index + 4)), [
        128,
        128,
        128,
        alpha,
      ]);
  };
  assert.equal(state.slots[0].nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0xf6]);
  assert.equal(await state.call(state.thread, 0, resident, 0), 0);
  assert.equal(pop32(state.thread), 0);
  assertPixels(0, 170);
  assert.equal(await state.call(state.thread, 0, partial, 1), 0);
  assert.equal(pop32(state.thread), 0);
  assertPixels(0, 85);

  const child = new AokanaBpThread({
      id: 2,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    node = state.scheduler.append(child);
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(state.thread, 0, resident, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.allocator.currentActor, actor);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assertPixels(0, 85);
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(child, 1, partial, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(state.loading.activeProcedures, 2);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(child.stackIndex, 0);
  assert.equal(await state.service.processNext(), true);
  assert.equal(state.allocator.currentActor, actor);
  assertPixels(0, 170);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(pop32(state.thread), 0);
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(await node.pollProcess(false), 0);
  assert.equal(await state.service.processNext(), true);
  assert.equal(state.allocator.currentActor, actor);
  assertPixels(1, 170);
  assert.equal(await node.pollProcess(false), 1);
  assert.equal(pop32(child), 0);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(await state.service.processNext(), false);
});
