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
import {createGroup81ResourceServices} from '../dist/engines/buriko/native/group-81-resource-services.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {updateNativeChecksum} from '../dist/engines/buriko/native/group-81-hash.js';
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

function checksumMetadata(payload) {
  const checksum = new Uint8Array(8);
  updateNativeChecksum({bytes: checksum, offset: 0}, {bytes: payload, offset: 0}, payload.length);
  return new DataView(checksum.buffer).getBigUint64(0, true);
}

function archive(payload, metadata = 1n) {
  const output = new Uint8Array(144 + payload.length),
    view = new DataView(output.buffer);
  output.set(bytes('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  output.set(bytes('entry'), 16);
  view.setUint32(112, 0, true);
  view.setUint32(116, payload.length, true);
  view.setBigUint64(120, metadata, true);
  output.set(payload, 144);
  return output;
}

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
    control = new BurikoVmControlState(),
    slots = createGroup81ResourceServices(loading, scheduler, procedures, clock, control),
    context = {thread, memory, diagnostics: {}};
  let nextText = 32;
  return {
    sources,
    allocator,
    loading,
    thread,
    memory,
    scheduler,
    control,
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

test('async resource service enqueues retain the invoking actor across mounted read suspension', async () => {
  for (const secondary of [0x30, 0x34]) {
    const state = setup(),
      payload = Uint8Array.of(61, 67, 71, 73),
      selected = archive(payload, checksumMetadata(payload)),
      source = new BlobSource(new Blob([selected]));
    let releaseRead;
    const readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let enteredRead;
    const readEntered = new Promise((resolve) => {
      enteredRead = resolve;
    });
    let held = false;
    state.sources.attach('/game/data.arc', {
      size: source.size,
      async read(offset, length) {
        if (!held) {
          held = true;
          enteredRead();
          await readGate;
        }
        return source.read(offset, length);
      },
    });
    const actor = {},
      ordinaryActor = state.allocator.currentActor;
    let enqueuedActor;
    if (secondary === 0x30) {
      const enqueue = state.loading.enqueueOwned.bind(state.loading);
      state.loading.enqueueOwned = (...args) => {
        enqueuedActor = args[6];
        return enqueue(...args);
      };
    } else {
      const enqueue = state.loading.enqueue.bind(state.loading);
      state.loading.enqueue = (...args) => {
        enqueuedActor = args[8];
        return enqueue(...args);
      };
    }
    const archiveName = state.name('data.arc'),
      resourceName = state.name('entry');
    if (secondary === 0x30) state.control.asynchronousResourceLoads = 1;
    const operation = state.allocator.withActor(actor, () =>
      secondary === 0x30
        ? state.call(0x30, 512, archiveName, resourceName, 0, 0)
        : state.call(0x34, archiveName, resourceName),
    );
    assert.equal(state.allocator.currentActor, ordinaryActor);
    await readEntered;
    releaseRead();
    assert.equal(await operation, 2);
    assert.equal(enqueuedActor, actor);
    assert.equal(await state.loading.processNext(), true);
    assert.equal(await state.scheduler.root.pollProcess(false), 1);
    assert.equal(state.loading.activeProcedures, 0);
    assert.equal(pop32(state.thread), 0);
    if (secondary === 0x30) assert.equal(state.memory.globalMemory[512], 61);
  }
});

test('81 30 synchronous branch reads one explicit stored range and pushes its raw status', async () => {
  const state = setup(),
    payload = Uint8Array.of(5, 7, 11, 13, 17),
    destination = 512;
  state.mount('/game/data.arc', archive(payload));
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 1, 3), 0);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + 3),
    Uint8Array.of(7, 11, 13),
  );
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.loading.hasPending, false);
});

test('81 30 asynchronous whole stored read uses one-shot scheduling and the shared cache', async () => {
  const state = setup(),
    payload = Uint8Array.of(19, 23, 29, 31, 37),
    destination = 512;
  state.mount('/game/data.arc', archive(payload));
  state.loading.cache.configure(1024);
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 0, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(state.loading.hasPending, true);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(await state.loading.processNext(), true);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.thread.stackIndex, 1);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + payload.length),
    payload,
  );
  assert.deepEqual(state.loading.cache.read(bytes('DATA.ARC'), bytes('ENTRY')), payload);

  state.memory.globalMemory.fill(0, destination, destination + payload.length);
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(0x30, destination, archiveName, resourceName, 0, 0), 2);
  assert.equal(state.control.asynchronousResourceLoads, 0);
  assert.equal(state.loading.hasPending, false);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(state.thread.stackIndex, 1);
  assert.equal(pop32(state.thread), 0);
  assert.deepEqual(
    state.memory.globalMemory.slice(destination, destination + payload.length),
    payload,
  );
});

test('81 30 asynchronous missing resource publishes failure when its process retires', async () => {
  const state = setup();
  state.control.asynchronousResourceLoads = 1;
  assert.equal(await state.call(0x30, 512, state.name('data.arc'), state.name('missing'), 0, 0), 2);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(pop32(state.thread), 1);
});

test('81 34 reads stored bytes and archive metadata through the shared FIFO before pushing health zero', async () => {
  const state = setup(),
    payload = Uint8Array.of(41, 43, 47, 53, 59);
  state.mount('/game/data.arc', archive(payload, checksumMetadata(payload)));
  const archiveName = state.name('data.arc'),
    resourceName = state.name('entry');
  for (const slot of state.slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  assert.equal(await state.call(0x34, archiveName, resourceName), 2);
  assert.equal(state.thread.stackIndex, 0);
  assert.equal(state.loading.activeProcedures, 1);
  assert.equal(state.loading.hasPending, true);
  assert.equal(await state.scheduler.root.pollProcess(false), 0);
  assert.equal(await state.loading.processNext(), true);
  assert.equal(await state.scheduler.root.pollProcess(false), 1);
  assert.equal(state.scheduler.root.process, null);
  assert.equal(state.loading.activeProcedures, 0);
  assert.equal(pop32(state.thread), 0);
});
