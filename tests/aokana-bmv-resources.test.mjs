import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {createGroup90BmvResources} from '../dist/engines/buriko/native/group-90-bmv-resources.js';
import {BurikoBmvRegistry} from '../dist/engines/buriko/native/bmv-registry.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const bytes = (value) => new TextEncoder().encode(value);

function setup() {
  const sources = new SourceFileSystem(windowsFileKey),
    fs = new WindowsFileSystem(sources, {
      cwd: 'C:\\game',
      mounts: [{windows: 'C:\\', virtual: '/'}],
    }),
    text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fs, text, media),
    allocator = new BurikoDistributedAllocator(1),
    unavailable = () => assert.fail('Successful synthetic resource service opened a diagnostic'),
    resources = new BurikoProgramResources(
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
      new BurikoDistributedProcessing(allocator, 1),
    ),
    loading = new BurikoResourceLoadingState(resources),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1024)),
    scheduler = new BurikoBpScheduler(thread, () => 1),
    procedures = new BurikoProcedureState(),
    clock = new BurikoNativeClock(() => 100),
    registry = new BurikoBmvRegistry(allocator),
    slots = createGroup90BmvResources(registry, loading, scheduler, procedures, clock),
    context = {thread, memory, diagnostics: {}};
  let nextText = 32;
  return {
    loading,
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
    async call(secondary, ...arguments_) {
      arguments_.forEach((value) => push32(thread, value));
      return slots.find((slot) => slot.secondary === secondary).execute(context);
    },
  };
}

test('90 F4 F7 F5 load an encoded movie through the shared FIFO and manage ordinary aliases', async () => {
  const state = setup(),
    payload = new Uint8Array(80),
    view = new DataView(payload.buffer);
  payload.set(bytes('BF_Movie_______\0'));
  view.setUint32(0x10, 0x10001, true);
  const metadata = [320, 180, 32, 40, 3];
  [0x14, 0x18, 0x20, 0x24, 0x28].forEach((offset, index) =>
    view.setUint32(offset, metadata[index], true),
  );
  state.mount('/game/sample.bmv', payload);
  state.loading.cache.configure(1024);
  const cached = payload.slice();
  new DataView(cached.buffer).setUint32(0x14, 160, true);
  state.loading.cache.insert(null, bytes('sample.bmv'), cached);
  const name = state.name('SAMPLE.BMV'),
    output = 512,
    info = 544,
    aliasOutput = 576,
    memory = new DataView(state.memory.globalMemory.buffer);
  for (const slot of state.slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  assert.equal(
    state.slots.some((slot) => slot.secondary === 0xf6),
    false,
  );
  assert.equal(await state.call(0xf4, output, info, 0, name), 2);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(state.loading.hasPending, true);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(await state.loading.processNext(), true);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(pop32(state.thread), 0);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.loading.hasPending, false);
  const first = memory.getUint32(output, true);
  assert.equal(first, 1);
  assert.deepEqual(
    Array.from({length: 5}, (_, index) => memory.getUint32(info + index * 4, true)),
    metadata,
  );
  assert.deepEqual(state.registry.find(first).resource.bytes, payload);
  assert.equal(state.registry.find(first).resource.provenance, null);
  assert.deepEqual(state.loading.cache.read(null, bytes('sample.bmv')), cached);

  assert.equal(await state.call(0xf7, aliasOutput, first), 0);
  assert.equal(pop32(state.thread), 0);
  const second = memory.getUint32(aliasOutput, true);
  assert.equal(second, 2);
  assert.equal(state.registry.find(second).resource, state.registry.find(first).resource);
  assert.equal(await state.call(0xf7, aliasOutput, second), 0);
  assert.equal(pop32(state.thread), 0);
  const third = memory.getUint32(aliasOutput, true);
  assert.equal(third, 3);
  assert.equal(state.registry.find(first).nextAlias, second);
  assert.equal(state.registry.find(second).nextAlias, third);
  assert.equal(state.registry.find(third).previousAlias, second);

  assert.equal(await state.call(0xf5, second), 0);
  assert.equal(pop32(state.thread), 0);
  assert.equal(state.registry.find(second), null);
  assert.equal(state.registry.find(first).nextAlias, third);
  assert.equal(state.registry.find(third).previousAlias, first);
  assert.equal(await state.call(0xf5, first), 0);
  assert.equal(pop32(state.thread), 0);
  assert.equal(state.registry.find(first), null);
  assert.equal(state.registry.find(third).previousAlias, 0);
  assert.deepEqual(state.registry.find(third).resource.bytes, payload);
  assert.equal(await state.call(0xf5, third), 0);
  assert.equal(pop32(state.thread), 0);
  assert.equal(state.registry.find(third), null);
});
