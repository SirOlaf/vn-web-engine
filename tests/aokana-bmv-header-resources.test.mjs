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
import {createGroup92BmvResources} from '../dist/engines/buriko/native/group-92-bmv-resources.js';
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
    slots = createGroup92BmvResources(registry, loading, scheduler, procedures, clock),
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

test('92 F1 uses full loading or two staged FIFO reads with real partial-resource provenance', async () => {
  const state = setup(),
    payload = new Uint8Array(400),
    header = new DataView(payload.buffer);
  payload.set(bytes('BF_Movie_______\0'));
  header.setUint32(0x10, 0x10001, true);
  header.setUint32(0x14, 8, true);
  header.setUint32(0x18, 8, true);
  header.setUint32(0x1c, 32, true);
  header.setUint32(0x20, 2, true);
  header.setUint32(0x24, 40, true);
  header.setUint32(0x28, 2, true);
  payload.fill(1, 0x40, 0xc0);
  header.setUint32(0xc0, 200, true);
  header.setUint32(0xc4, 300, true);
  payload.fill(0x5a, 200);
  state.mount('/game/sample.bmv', payload);
  const name = state.name('SaMpLe.BmV'),
    output = 512,
    info = 544;
  const view = new DataView(state.memory.globalMemory.buffer);
  const slot = state.slots[0];
  assert.equal(slot.primary, 0x92);
  assert.equal(slot.secondary, 0xf1);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][0xf1]);
  for (const mode of [0, 1]) {
    assert.equal(await state.call(0xf1, output, info, 0, name, mode), 2);
    assert.equal(state.thread.stackIndex, 0);
    assert.equal(state.loading.activeProcedures, 1);
    assert.equal(state.loading.hasPending, mode === 0);
    assert.equal(await state.scheduler.root.pollProcess(false), 0);
    assert.equal(state.loading.hasPending, true);
    assert.equal(await state.loading.processNext(), true);
    if (mode !== 0) {
      assert.equal(await state.scheduler.root.pollProcess(false), 0);
      assert.equal(state.loading.hasPending, true);
      assert.equal(await state.scheduler.root.pollProcess(false), 0);
      assert.equal(await state.loading.processNext(), true);
    }
    assert.equal(await state.scheduler.root.pollProcess(false), 1);
    assert.equal(pop32(state.thread), 0);
    assert.equal(state.loading.activeProcedures, 0);
    assert.equal(state.loading.hasPending, false);
    assert.equal(state.scheduler.root.process, null);
    const id = view.getUint32(output, true),
      resource = state.registry.find(id).resource;
    assert.deepEqual(
      Array.from({length: 5}, (_, index) => view.getUint32(info + index * 4, true)),
      [8, 8, 2, 40, 2],
    );
    assert.deepEqual(resource.bytes, mode === 0 ? payload : payload.subarray(0, 200));
    if (mode === 0) assert.equal(resource.provenance, null);
    else {
      assert.deepEqual(resource.provenance, {
        archive: null,
        name: bytes('SaMpLe.BmV\0'),
        length: 400,
      });
      const frame = new Uint8Array(100);
      const read = await state.loading.ranges.read(
        {bytes: frame, offset: 0},
        resource.provenance.archive,
        resource.provenance.name,
        new DataView(resource.bytes.buffer).getUint32(0xc4, true),
        100,
      );
      assert.equal(read.result, 0);
      assert.deepEqual(frame, payload.subarray(300));
    }
    assert.equal(state.registry.remove(id), 0);
  }
});
